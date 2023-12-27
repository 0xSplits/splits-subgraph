import { BigInt, Bytes, ethereum, log, store } from '@graphprotocol/graph-ts'
import { CreateSwapper } from '../generated/SwapperFactory/SwapperFactory'
import {
  SetBeneficiary,
  SetTokenToBeneficiary,
  SetOracle,
  SetPaused,
  OwnershipTransferred,
  ExecCalls,
  Flash,
  SetDefaultScaledOfferFactor,
  SetPairScaledOfferFactors,
} from '../generated/templates/Swapper/Swapper'
import { Swapper as SwapperTemplate } from '../generated/templates'
import {
  Token,
  User,
  Swapper,
  SwapBalance,
  CreateSwapperEvent,
  SwapperBeneficiaryAddedEvent,
  SwapperBeneficiaryRemovedEvent,
  UpdateSwapperBeneficiaryEvent,
  UpdateSwapperTokenEvent,
  UpdateSwapperOracleEvent,
  UpdateSwapperDefaultScaledOfferFactorEvent,
  UpdateSwapperScaledOfferFactorOverridesEvent,
  SwapFundsEvent,
  ReceiveSwappedFundsEvent,
  SwapperPairOverride,
  UnknownOracle,
  UniswapV3TWAPOracle,
  ChainlinkOracle,
} from '../generated/schema'
import {
  createJointId,
  createTransactionIfMissing,
  createUserIfMissing,
  getSwapper,
  ADDED_PREFIX,
  REMOVED_PREFIX,
  RECEIVE_PREFIX,
  ZERO,
  ZERO_ADDRESS,
  TRANSFER_EVENT_TOPIC,
  WETH_WITHDRAWAL_EVENT_TOPIC,
  getAddressHexFromBytes32,
  WETH_DEPOSIT_EVENT_TOPIC,
  updateWithdrawalAmount,
  updateDistributionAmount,
} from './helpers'

const CREATE_SWAPPER_EVENT_PREFIX = 'cswe'
const UPDATE_SWAPPER_BENEFICIARY_EVENT_PREFIX = 'usbe'
const UPDATE_SWAPPER_TOKEN_EVENT_PREFIX = 'uste'
const UPDATE_SWAPPER_ORACLE_EVENT_PREFIX = 'usoe'
const UPDATE_SWAPPER_DEFAULT_SCALED_OFFER_FACTOR_EVENT_PREFIX = 'usdsofe'
const UPDATE_SWAPPER_SCALED_OFFER_FACTOR_OVERRIDES_EVENT_PREFIX = 'ussofoe'
const SWAP_FUNDS_EVENT_PREFIX = 'sfe'

export function handleCreateSwapper(event: CreateSwapper): void {
  let swapperId = event.params.swapper.toHexString()

  // If a user already exists at this id, just return for now. Cannot have two
  // entities with the same id if they share an interface. Will handle this situation
  // in subgraph v2.
  let swapperUser = User.load(swapperId)
  if (swapperUser) {
    log.warning('Trying to create a swapper, but a user already exists: {}', [
      swapperId,
    ])
    return
  }

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp
  let txHash = event.transaction.hash.toHexString()
  createTransactionIfMissing(txHash)
  let logIdx = event.logIndex

  let swapper = new Swapper(swapperId)

  let owner = event.params.params.owner.toHexString()
  let paused = event.params.params.paused
  let beneficiary = event.params.params.beneficiary.toHexString()
  let tokenToBeneficiary = event.params.params.tokenToBeneficiary.toHexString()
  let oracleId = event.params.params.oracle.toHexString()
  let defaultScaledOfferFactor = event.params.params.defaultScaledOfferFactor
  let scaledOfferFactorPairOverrides =
    event.params.params.pairScaledOfferFactors

  createUserIfMissing(owner, blockNumber, timestamp)
  createUserIfMissing(beneficiary, blockNumber, timestamp)
  createOracleIfMissing(oracleId)
  let token = new Token(tokenToBeneficiary)
  token.save()

  swapper.type = 'swapper'
  swapper.owner = owner
  swapper.paused = paused
  swapper.beneficiary = beneficiary
  swapper.tokenToBeneficiary = tokenToBeneficiary
  swapper.oracle = oracleId
  swapper.defaultScaledOfferFactor = defaultScaledOfferFactor
  swapper.createdBlock = blockNumber
  swapper.latestBlock = blockNumber
  swapper.latestActivity = timestamp

  for (let i: i32 = 0; i < scaledOfferFactorPairOverrides.length; i++) {
    let quotePair = scaledOfferFactorPairOverrides[i].quotePair

    let base = quotePair.base.toHexString()
    let baseToken = new Token(base)
    baseToken.save()

    let quote = quotePair.quote.toHexString()
    let quoteToken = new Token(quote)
    quoteToken.save()

    let scaledOfferFactor = scaledOfferFactorPairOverrides[i].scaledOfferFactor

    updatePairOverride(swapperId, base, quote, scaledOfferFactor)
  }

  swapper.save()
  SwapperTemplate.create(event.params.swapper)

  // Save events
  let createSwapperEventId = createJointId([
    CREATE_SWAPPER_EVENT_PREFIX,
    txHash,
    logIdx.toString(),
  ])
  let createSwapperEvent = new CreateSwapperEvent(createSwapperEventId)
  createSwapperEvent.timestamp = timestamp
  createSwapperEvent.transaction = txHash
  createSwapperEvent.logIndex = logIdx
  createSwapperEvent.account = swapperId
  createSwapperEvent.token = tokenToBeneficiary
  createSwapperEvent.save()

  let beneficiaryAddedEventId = createJointId([
    ADDED_PREFIX,
    createSwapperEventId,
  ])
  let beneficiaryAddedEvent = new SwapperBeneficiaryAddedEvent(
    beneficiaryAddedEventId,
  )
  beneficiaryAddedEvent.timestamp = timestamp
  beneficiaryAddedEvent.logIndex = logIdx
  beneficiaryAddedEvent.account = beneficiary
  beneficiaryAddedEvent.createSwapperEvent = createSwapperEventId
  beneficiaryAddedEvent.save()
}

export function handleSetBeneficiary(event: SetBeneficiary): void {
  let swapperId = event.address.toHexString()

  let swapper = getSwapper(swapperId)
  if (!swapper) return

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp
  let txHash = event.transaction.hash.toHexString()
  createTransactionIfMissing(txHash)
  let logIdx = event.logIndex

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber
    swapper.latestActivity = timestamp
  }

  let newBeneficiary = event.params.beneficiary.toHexString()
  createUserIfMissing(newBeneficiary, blockNumber, timestamp)

  let oldBeneficiary = swapper.beneficiary
  swapper.beneficiary = newBeneficiary
  swapper.save()

  // Save events
  let updateBeneficiaryEventId = createJointId([
    UPDATE_SWAPPER_BENEFICIARY_EVENT_PREFIX,
    txHash,
    logIdx.toString(),
  ])
  let updateBeneficiaryEvent = new UpdateSwapperBeneficiaryEvent(
    updateBeneficiaryEventId,
  )
  updateBeneficiaryEvent.timestamp = timestamp
  updateBeneficiaryEvent.transaction = txHash
  updateBeneficiaryEvent.logIndex = logIdx
  updateBeneficiaryEvent.account = swapperId
  updateBeneficiaryEvent.save()

  let beneficiaryAddedEventId = createJointId([
    ADDED_PREFIX,
    updateBeneficiaryEventId,
  ])
  let beneficiaryAddedEvent = new SwapperBeneficiaryAddedEvent(
    beneficiaryAddedEventId,
  )
  beneficiaryAddedEvent.timestamp = timestamp
  beneficiaryAddedEvent.logIndex = logIdx
  beneficiaryAddedEvent.account = newBeneficiary
  beneficiaryAddedEvent.updateSwapperEvent = updateBeneficiaryEventId
  beneficiaryAddedEvent.save()

  let beneficiaryRemovedEventId = createJointId([
    REMOVED_PREFIX,
    updateBeneficiaryEventId,
  ])
  let beneficiaryRemovedEvent = new SwapperBeneficiaryRemovedEvent(
    beneficiaryRemovedEventId,
  )
  beneficiaryRemovedEvent.timestamp = timestamp
  beneficiaryRemovedEvent.logIndex = logIdx
  beneficiaryRemovedEvent.account = oldBeneficiary
  beneficiaryRemovedEvent.updateSwapperEvent = updateBeneficiaryEventId
  beneficiaryRemovedEvent.save()
}

export function handleSetTokenToBeneficiary(
  event: SetTokenToBeneficiary,
): void {
  let swapperId = event.address.toHexString()

  let swapper = getSwapper(swapperId)
  if (!swapper) return

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp
  let txHash = event.transaction.hash.toHexString()
  createTransactionIfMissing(txHash)
  let logIdx = event.logIndex

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber
    swapper.latestActivity = timestamp
  }

  let newToken = event.params.tokenToBeneficiary.toHexString()
  let token = new Token(newToken)
  token.save()

  let oldToken = swapper.tokenToBeneficiary
  swapper.tokenToBeneficiary = newToken
  swapper.save()

  // Save events
  let updateTokenEventId = createJointId([
    UPDATE_SWAPPER_TOKEN_EVENT_PREFIX,
    txHash,
    logIdx.toString(),
  ])
  let updateTokenEvent = new UpdateSwapperTokenEvent(updateTokenEventId)
  updateTokenEvent.timestamp = timestamp
  updateTokenEvent.transaction = txHash
  updateTokenEvent.logIndex = logIdx
  updateTokenEvent.account = swapperId
  updateTokenEvent.oldToken = oldToken
  updateTokenEvent.newToken = newToken
  updateTokenEvent.save()
}

export function handleSetOracle(event: SetOracle): void {
  let swapperId = event.address.toHexString()

  let swapper = getSwapper(swapperId)
  if (!swapper) return

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp
  let txHash = event.transaction.hash.toHexString()
  createTransactionIfMissing(txHash)
  let logIdx = event.logIndex

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber
    swapper.latestActivity = timestamp
  }

  let oracleId = event.params.oracle.toHexString()
  createOracleIfMissing(oracleId)

  let oldOracleId = swapper.oracle
  swapper.oracle = oracleId
  swapper.save()

  // Save events
  let updateOracleEventId = createJointId([
    UPDATE_SWAPPER_ORACLE_EVENT_PREFIX,
    txHash,
    logIdx.toString(),
  ])
  let updateOracleEvent = new UpdateSwapperOracleEvent(updateOracleEventId)
  updateOracleEvent.timestamp = timestamp
  updateOracleEvent.transaction = txHash
  updateOracleEvent.logIndex = logIdx
  updateOracleEvent.account = swapperId
  updateOracleEvent.oldOracle = oldOracleId
  updateOracleEvent.newOracle = oracleId
  updateOracleEvent.save()
}

export function handleSetDefaultScaledOfferFactor(
  event: SetDefaultScaledOfferFactor,
): void {
  let swapperId = event.address.toHexString()

  let swapper = getSwapper(swapperId)
  if (!swapper) return

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp
  let txHash = event.transaction.hash.toHexString()
  createTransactionIfMissing(txHash)
  let logIdx = event.logIndex

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber
    swapper.latestActivity = timestamp
  }

  let defaultScaledOfferFactor = event.params.defaultScaledOfferFactor

  let oldScaledOfferFactor = swapper.defaultScaledOfferFactor
  swapper.defaultScaledOfferFactor = defaultScaledOfferFactor
  swapper.save()

  // Save events
  let updateDefaultScaledOfferFactorEventId = createJointId([
    UPDATE_SWAPPER_DEFAULT_SCALED_OFFER_FACTOR_EVENT_PREFIX,
    txHash,
    logIdx.toString(),
  ])
  let updateDefaultScaledOfferFactorEvent = new UpdateSwapperDefaultScaledOfferFactorEvent(
    updateDefaultScaledOfferFactorEventId,
  )
  updateDefaultScaledOfferFactorEvent.timestamp = timestamp
  updateDefaultScaledOfferFactorEvent.transaction = txHash
  updateDefaultScaledOfferFactorEvent.logIndex = logIdx
  updateDefaultScaledOfferFactorEvent.account = swapperId
  updateDefaultScaledOfferFactorEvent.oldScaledOfferFactor = oldScaledOfferFactor
  updateDefaultScaledOfferFactorEvent.newScaledOfferFactor = defaultScaledOfferFactor
  updateDefaultScaledOfferFactorEvent.save()
}

export function handleSetPairScaledOfferFactors(
  event: SetPairScaledOfferFactors,
): void {
  let swapperId = event.address.toHexString()

  let swapper = getSwapper(swapperId)
  if (!swapper) return

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp
  let txHash = event.transaction.hash.toHexString()
  createTransactionIfMissing(txHash)
  let logIdx = event.logIndex

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber
    swapper.latestActivity = timestamp
  }

  let scaledOfferFactorPairOverrides = event.params.params

  for (let i: i32 = 0; i < scaledOfferFactorPairOverrides.length; i++) {
    let quotePair = scaledOfferFactorPairOverrides[i].quotePair

    let base = quotePair.base.toHexString()
    let baseToken = new Token(base)
    baseToken.save()

    let quote = quotePair.quote.toHexString()
    let quoteToken = new Token(quote)
    quoteToken.save()

    let scaledOfferFactor = scaledOfferFactorPairOverrides[i].scaledOfferFactor

    updatePairOverride(swapperId, base, quote, scaledOfferFactor)
  }

  swapper.save()

  // Save events
  let updateScaledOfferFactorOverridesEventId = createJointId([
    UPDATE_SWAPPER_SCALED_OFFER_FACTOR_OVERRIDES_EVENT_PREFIX,
    txHash,
    logIdx.toString(),
  ])
  let updateScaledOfferFactorOverridesEvent = new UpdateSwapperScaledOfferFactorOverridesEvent(
    updateScaledOfferFactorOverridesEventId,
  )
  updateScaledOfferFactorOverridesEvent.timestamp = timestamp
  updateScaledOfferFactorOverridesEvent.transaction = txHash
  updateScaledOfferFactorOverridesEvent.logIndex = logIdx
  updateScaledOfferFactorOverridesEvent.account = swapperId
  updateScaledOfferFactorOverridesEvent.save()
}

export function handleSetPaused(event: SetPaused): void {
  let swapperId = event.address.toHexString()

  let swapper = getSwapper(swapperId)
  if (!swapper) return

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber
    swapper.latestActivity = timestamp
  }

  swapper.paused = event.params.paused
  swapper.save()

  // TODO: Save event
}

export function handleOwnershipTransferred(event: OwnershipTransferred): void {
  let swapperId = event.address.toHexString()

  let swapper = getSwapper(swapperId)
  if (!swapper) return

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber
    swapper.latestActivity = timestamp
  }

  let newOwner = event.params.newOwner.toHexString()
  createUserIfMissing(newOwner, blockNumber, timestamp)

  swapper.owner = newOwner
  swapper.save()

  // TODO: Save event
}

export function handleExecCalls(event: ExecCalls): void {
  let swapperId = event.address.toHexString()

  let swapper = getSwapper(swapperId)
  if (!swapper) return

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber
    swapper.latestActivity = timestamp
  }

  handleOwnerSwap(swapper, event)

  swapper.save()
}

export function handleFlash(event: Flash): void {
  let swapperId = event.address.toHexString()

  let swapper = getSwapper(swapperId)
  if (!swapper) return

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp
  let txHash = event.transaction.hash.toHexString()
  createTransactionIfMissing(txHash)
  let logIdx = event.logIndex

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber
    swapper.latestActivity = timestamp
  }

  let tokenToBeneficiary = event.params.tokenToBeneficiary.toHexString()
  let amountsToBeneificiary = event.params.amountsToBeneficiary
  let excessToBeneficiary = event.params.excessToBeneficiary
  let quoteParams = event.params.quoteParams

  for (let i: i32 = 0; i < quoteParams.length; i++) {
    let inputAmount = quoteParams[i].baseAmount
    let outputAmount = amountsToBeneificiary[i]
    let inputTokenId = quoteParams[i].quotePair.base.toHexString()
    let token = new Token(inputTokenId)
    token.save()

    updateSwapBalance(
      swapperId,
      swapper.beneficiary,
      inputTokenId,
      inputAmount,
      tokenToBeneficiary,
      outputAmount,
      timestamp,
      txHash,
      logIdx,
    )
  }

  if (excessToBeneficiary.gt(ZERO)) {
    // The excess amount was "swapped" for itself
    updateSwapBalance(
      swapperId,
      swapper.beneficiary,
      tokenToBeneficiary,
      excessToBeneficiary,
      tokenToBeneficiary,
      excessToBeneficiary,
      timestamp,
      txHash,
      logIdx,
    )
  }

  swapper.save()
}

class SwapBalanceData {
  inputAmount: BigInt
  outputs: Map<string, BigInt>
}

function updateSwapBalanceData(
  swapBalanceData: Map<string, SwapBalanceData>,
  inputToken: string,
  outputToken: string,
  inputAmount: BigInt,
  outputAmount: BigInt,
): void {
  if (!swapBalanceData.has(inputToken)) {
    let newData: SwapBalanceData = {
      inputAmount: ZERO,
      outputs: new Map(),
    }
    newData.outputs.set(outputToken, ZERO)
    swapBalanceData.set(inputToken, newData)
  }

  let swapData = swapBalanceData.get(inputToken)
  swapData.inputAmount += inputAmount

  let currentOutputAmount = swapData.outputs.get(outputToken)
  swapData.outputs.set(outputToken, currentOutputAmount + outputAmount)
}

function handleOwnerSwap(swapper: Swapper, event: ExecCalls): void {
  let swapperId = swapper.id

  let timestamp = event.block.timestamp
  let txHash = event.transaction.hash.toHexString()
  createTransactionIfMissing(txHash)
  let logIdx = event.logIndex

  let swapBalanceData = new Map<string, SwapBalanceData>()

  let calls = event.params.calls
  for (let i: i32 = 0; i < calls.length; i++) {
    let toAddress = calls[i].to.toHexString()
    if (toAddress == swapper.beneficiary) {
      // Handle direct eth transfer to beneficiary. It's possible we accidentally
      // count a weth --> eth swap here, will handle subtracting that amount
      // in the weth withdrawal event.
      let value = calls[i].value

      updateSwapBalanceData(
        swapBalanceData,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        value,
        value,
      )
    }
  }

  let receipt = event.receipt as ethereum.TransactionReceipt
  if (receipt) {
    let receiptLogs = receipt.logs
    let pendingInputToken = ''
    let pendingInputAmount = ZERO
    let pendingOutputToken = ''
    let pendingOutputAmount = ZERO

    for (let i: i32 = 0; i < receiptLogs.length; i++) {
      let receiptLog = receiptLogs[i]
      let topic0 = receiptLog.topics[0].toHexString()

      if (topic0 == TRANSFER_EVENT_TOPIC) {
        let token = receiptLog.address.toHexString()
        let fromAddress = getAddressHexFromBytes32(
          receiptLog.topics[1].toHexString(),
        )
        let toAddress = getAddressHexFromBytes32(
          receiptLog.topics[2].toHexString(),
        )
        let amount = BigInt.fromUnsignedBytes(
          Bytes.fromUint8Array(receiptLog.data.reverse()),
        )

        if (fromAddress == swapperId) {
          pendingInputToken = token
          pendingInputAmount = amount

          // Handle direct transfer from swapper to beneficiary
          if (toAddress == swapper.beneficiary) {
            updateSwapBalanceData(swapBalanceData, token, token, amount, amount)
          } else if (pendingOutputToken != '') {
            // Output transfer was processed first. Update swap balances now
            // that we have input data
            updateSwapBalanceData(
              swapBalanceData,
              token,
              pendingOutputToken,
              amount,
              pendingOutputAmount,
            )

            pendingOutputToken = ''
            pendingOutputAmount = ZERO
          }
        } else if (toAddress == swapperId) {
          updateSwapBalanceData(
            swapBalanceData,
            pendingInputToken,
            token,
            pendingInputAmount,
            amount,
          )
        } else if (toAddress == swapper.beneficiary) {
          // We got the output data before the input data
          pendingOutputToken = token
          pendingOutputAmount = amount
        }
      } else if (topic0 == WETH_DEPOSIT_EVENT_TOPIC) {
        let token = receiptLog.address.toHexString()
        let depositor = getAddressHexFromBytes32(
          receiptLog.topics[1].toHexString(),
        )
        let amount = BigInt.fromUnsignedBytes(
          Bytes.fromUint8Array(receiptLog.data.reverse()),
        )

        if (depositor == swapperId) {
          // It's a eth --> weth trade. Got double counted in the transfer event handler
          // though as weth --> weth.

          updateSwapBalanceData(
            swapBalanceData,
            ZERO_ADDRESS,
            token,
            amount,
            amount,
          )
          updateSwapBalanceData(
            swapBalanceData,
            token,
            token,
            amount.neg(),
            amount.neg(),
          )
        } else if (pendingOutputToken != '') {
          // Output transfer was processed first. Update swap balances now
          // that we have input data
          updateSwapBalanceData(
            swapBalanceData,
            ZERO_ADDRESS,
            pendingOutputToken,
            amount,
            pendingOutputAmount,
          )

          pendingOutputToken = ''
          pendingOutputAmount = ZERO
        }
      } else if (topic0 == WETH_WITHDRAWAL_EVENT_TOPIC) {
        let token = receiptLog.address.toHexString()
        let recipient = getAddressHexFromBytes32(
          receiptLog.topics[1].toHexString(),
        )
        let amount = BigInt.fromUnsignedBytes(
          Bytes.fromUint8Array(receiptLog.data.reverse()),
        )

        if (recipient == swapperId) {
          // We counted this as eth --> eth up above instead of weth --> eth. Add the correct
          // swap balance, and also subtract from eth --> eth
          updateSwapBalanceData(
            swapBalanceData,
            token,
            ZERO_ADDRESS,
            amount,
            amount,
          )
          updateSwapBalanceData(
            swapBalanceData,
            ZERO_ADDRESS,
            ZERO_ADDRESS,
            amount.neg(),
            amount.neg(),
          )
        } else {
          updateSwapBalanceData(
            swapBalanceData,
            pendingInputToken,
            ZERO_ADDRESS,
            pendingInputAmount,
            amount,
          )
        }
      }
    }
  }

  const inputTokens = swapBalanceData.keys()
  for (let i: i32 = 0; i < inputTokens.length; i++) {
    let inputToken = inputTokens[i]
    let swapData = swapBalanceData.get(inputToken)

    let token = new Token(inputToken)
    token.save()

    let outputTokens = swapData.outputs.keys()
    for (let j: i32 = 0; j < outputTokens.length; j++) {
      let outputToken = outputTokens[j]
      let outputAmount = swapData.outputs.get(outputToken)

      updateSwapBalance(
        swapperId,
        swapper.beneficiary,
        inputToken,
        swapData.inputAmount,
        outputToken,
        outputAmount,
        timestamp,
        txHash,
        logIdx,
      )
    }
  }
}

function updateSwapBalance(
  swapperId: string,
  beneficiary: string,
  inputTokenId: string,
  inputAmount: BigInt,
  outputTokenId: string,
  outputAmount: BigInt,
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt,
): void {
  let swapBalanceId = createJointId([swapperId, inputTokenId, outputTokenId])
  let swapBalance = SwapBalance.load(swapBalanceId)
  if (!swapBalance) {
    swapBalance = new SwapBalance(swapBalanceId)
    swapBalance.swapper = swapperId
    swapBalance.inputToken = inputTokenId
    swapBalance.outputToken = outputTokenId
    swapBalance.inputAmount = ZERO
    swapBalance.outputAmount = ZERO
  }
  swapBalance.inputAmount += inputAmount
  swapBalance.outputAmount += outputAmount

  swapBalance.save()

  updateDistributionAmount(swapperId, inputTokenId, inputAmount)

  // Only need to update withdrawn for users. For all modules, swapped funds
  // will show up in their active balances.
  let user = User.load(beneficiary)
  if (user) {
    updateWithdrawalAmount(swapperId, beneficiary, outputTokenId, outputAmount)
  }

  // Save events
  let swapFundsEventId = createJointId([
    SWAP_FUNDS_EVENT_PREFIX,
    inputTokenId,
    txHash,
    logIdx.toString(),
  ])
  let swapFundsEvent = SwapFundsEvent.load(swapFundsEventId)
  if (!swapFundsEvent) {
    swapFundsEvent = new SwapFundsEvent(swapFundsEventId)
    swapFundsEvent.timestamp = timestamp
    swapFundsEvent.transaction = txHash
    swapFundsEvent.logIndex = logIdx
    swapFundsEvent.account = swapperId
    swapFundsEvent.inputToken = inputTokenId
    swapFundsEvent.outputToken = outputTokenId

    swapFundsEvent.inputAmount = ZERO
    swapFundsEvent.outputAmount = ZERO
  }
  swapFundsEvent.inputAmount += inputAmount
  swapFundsEvent.outputAmount += outputAmount
  swapFundsEvent.save()

  let receiveSwappedFundsEventId = createJointId([
    RECEIVE_PREFIX,
    SWAP_FUNDS_EVENT_PREFIX,
    inputTokenId,
    txHash,
    logIdx.toString(),
  ])
  let receiveSwappedFundsEvent = new ReceiveSwappedFundsEvent(
    receiveSwappedFundsEventId,
  )
  receiveSwappedFundsEvent.timestamp = timestamp
  receiveSwappedFundsEvent.logIndex = logIdx
  receiveSwappedFundsEvent.account = beneficiary
  receiveSwappedFundsEvent.swapFundsEvent = swapFundsEventId
  receiveSwappedFundsEvent.save()
}

function createOracleIfMissing(oracleId: string): void {
  let uniswapOracle = UniswapV3TWAPOracle.load(oracleId)
  let chainlinkOracle = ChainlinkOracle.load(oracleId)
  let unknownOracle = UnknownOracle.load(oracleId)
  if (!uniswapOracle && !chainlinkOracle && !unknownOracle) {
    let oracle = new UnknownOracle(oracleId)
    oracle.type = 'unknown'
    oracle.save()
  }
}

function updatePairOverride(
  swapperId: string,
  baseToken: string,
  quoteToken: string,
  scaledOfferFactor: BigInt,
): void {
  let pairOverrideId = createJointId([swapperId, baseToken, quoteToken])
  let pairOverride = SwapperPairOverride.load(pairOverrideId)
  if (!pairOverride) {
    pairOverride = new SwapperPairOverride(pairOverrideId)
    pairOverride.swapper = swapperId
    pairOverride.base = baseToken
    pairOverride.quote = quoteToken
  }
  pairOverride.scaledOfferFactor = scaledOfferFactor

  if (scaledOfferFactor == ZERO) {
    store.remove('SwapperPairOverride', pairOverrideId)
  } else {
    pairOverride.save()
  }
}
