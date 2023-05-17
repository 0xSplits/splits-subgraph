import { BigInt, Bytes, ethereum, log } from "@graphprotocol/graph-ts";
import { CreateSwapper } from "../generated/SwapperFactory/SwapperFactory";
import {
  SetBeneficiary,
  SetTokenToBeneficiary,
  SetOracle,
  SetPaused,
  OwnershipTransferred,
  ExecCalls,
  Flash,
} from "../generated/templates/Swapper/Swapper";
import { Swapper as SwapperTemplate } from "../generated/templates";
import {
  Token,
  User,
  Swapper,
  SwapBalance,
  TokenWithdrawal,
  Oracle,
  CreateSwapperEvent,
  UpdateSwapperBeneficiaryEvent,
  UpdateSwapperTokenEvent,
  SwapFundsEvent,
  ReceiveSwappedFundsEvent,
  SwapperPairOverride,
} from "../generated/schema";
import {
  createJointId,
  createTransactionIfMissing,
  createUserIfMissing,
  getSwapper,
  RECEIVE_PREFIX,
  TOKEN_WITHDRAWAL_USER_PREFIX,
  ZERO,
  ZERO_ADDRESS,
} from "./helpers";

const CREATE_SWAPPER_EVENT_PREFIX = "cswe";
const UPDATE_SWAPPER_BENEFICIARY_EVENT_PREFIX = "usbe";
const UPDATE_SWAPPER_TOKEN_EVENT_PREFIX = "uste";
const SWAP_FUNDS_EVENT_PREFIX = "sfe";

const TRANSFER_EVENT_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WETH_WITHDRAWAL_EVENT_TOPIC = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

export function handleCreateSwapper(event: CreateSwapper): void {
  let swapperId = event.params.swapper.toHexString();

  // If a user already exists at this id, just return for now. Cannot have two
  // entities with the same id if they share an interface. Will handle this situation
  // in subgraph v2.
  let swapperUser = User.load(swapperId);
  if (swapperUser) {
    log.warning('Trying to create a swapper, but a user already exists: {}', [swapperId]);
    return;
  }

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  createTransactionIfMissing(txHash);
  let logIdx = event.logIndex;

  let swapper = new Swapper(swapperId);

  let owner = event.params.params.owner.toHexString();
  let paused = event.params.params.paused;
  let beneficiary = event.params.params.beneficiary.toHexString();
  let tokenToBeneficiary = event.params.params.tokenToBeneficiary.toHexString();
  let oracleId = event.params.params.oracle.toHexString();
  let defaultScaledOfferFactor = event.params.params.defaultScaledOfferFactor;
  let scaledOfferFactorPairOverrides = event.params.params.pairScaledOfferFactors;

  createUserIfMissing(owner, blockNumber, timestamp);
  createUserIfMissing(beneficiary, blockNumber, timestamp);
  createOracleIfMissing(oracleId);
  let token = new Token(tokenToBeneficiary);
  token.save();

  swapper.owner = owner;
  swapper.paused = paused;
  swapper.beneficiary = beneficiary;
  swapper.tokenToBeneficiary = tokenToBeneficiary;
  swapper.oracle = oracleId;
  swapper.defaultScaledOfferFactor = defaultScaledOfferFactor;
  swapper.createdBlock = blockNumber;
  swapper.latestBlock = blockNumber;
  swapper.latestActivity = timestamp;

  for (let i: i32 = 0; i < scaledOfferFactorPairOverrides.length; i++) {
    let quotePair = scaledOfferFactorPairOverrides[i].quotePair;

    let base = quotePair.base.toHexString();
    let baseToken = new Token(base);
    baseToken.save();

    let quote = quotePair.quote.toHexString();
    let quoteToken = new Token(quote);
    quoteToken.save();

    let scaledOfferFactor = scaledOfferFactorPairOverrides[i].scaledOfferFactor;

    updatePairOverride(swapperId, base, quote, scaledOfferFactor);
  }

  swapper.save();
  SwapperTemplate.create(event.params.swapper);

  // Save events
  let createSwapperEventId = createJointId([CREATE_SWAPPER_EVENT_PREFIX, txHash, logIdx.toString()]);
  let createSwapperEvent = new CreateSwapperEvent(createSwapperEventId);
  createSwapperEvent.timestamp = timestamp;
  createSwapperEvent.transaction = txHash;
  createSwapperEvent.logIndex = logIdx;
  createSwapperEvent.account = swapperId;
  createSwapperEvent.beneficiary = beneficiary;
  createSwapperEvent.token = tokenToBeneficiary;
  createSwapperEvent.save();
}

export function handleSetBeneficiary(event: SetBeneficiary): void {
  let swapperId = event.address.toHexString();

  let swapper = getSwapper(swapperId);
  if (!swapper) return;

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  createTransactionIfMissing(txHash);
  let logIdx = event.logIndex;

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber;
    swapper.latestActivity = timestamp;
  }

  let newBeneficiary = event.params.beneficiary.toHexString();
  createUserIfMissing(newBeneficiary, blockNumber, timestamp);

  let oldBeneficiary = swapper.beneficiary;
  swapper.beneficiary = newBeneficiary;
  swapper.save();

  // Save events
  let updateBeneficiaryEventId = createJointId([UPDATE_SWAPPER_BENEFICIARY_EVENT_PREFIX, txHash, logIdx.toString()]);
  let updateBeneficiaryEvent = new UpdateSwapperBeneficiaryEvent(updateBeneficiaryEventId);
  updateBeneficiaryEvent.timestamp = timestamp;
  updateBeneficiaryEvent.transaction = txHash;
  updateBeneficiaryEvent.logIndex = logIdx;
  updateBeneficiaryEvent.account = swapperId;
  updateBeneficiaryEvent.oldBeneficiary = oldBeneficiary;
  updateBeneficiaryEvent.newBeneficiary = newBeneficiary;
  updateBeneficiaryEvent.save();
}

export function handleSetTokenToBeneficiary(event: SetTokenToBeneficiary): void {
  let swapperId = event.address.toHexString();

  let swapper = getSwapper(swapperId);
  if (!swapper) return;

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  createTransactionIfMissing(txHash);
  let logIdx = event.logIndex;

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber;
    swapper.latestActivity = timestamp;
  }

  let newToken = event.params.tokenToBeneficiary.toHexString();
  let token = new Token(newToken);
  token.save();

  let oldToken = swapper.tokenToBeneficiary;
  swapper.tokenToBeneficiary = newToken;
  swapper.save();

  // Save events
  let updateTokenEventId = createJointId([UPDATE_SWAPPER_TOKEN_EVENT_PREFIX, txHash, logIdx.toString()]);
  let updateTokenEvent = new UpdateSwapperTokenEvent(updateTokenEventId);
  updateTokenEvent.timestamp = timestamp;
  updateTokenEvent.transaction = txHash;
  updateTokenEvent.logIndex = logIdx;
  updateTokenEvent.account = swapperId;
  updateTokenEvent.oldToken = oldToken;
  updateTokenEvent.newToken = newToken;
  updateTokenEvent.save();
}

export function handleSetOracle(event: SetOracle): void {
  let swapperId = event.address.toHexString();

  let swapper = getSwapper(swapperId);
  if (!swapper) return;

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber;
    swapper.latestActivity = timestamp;
  }

  let oracleId = event.params.oracle.toHexString();
  createOracleIfMissing(oracleId);

  swapper.oracle = oracleId;
  swapper.save();

  // TODO: Save event
}

export function handleSetPaused(event: SetPaused): void {
  let swapperId = event.address.toHexString();

  let swapper = getSwapper(swapperId);
  if (!swapper) return;

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber;
    swapper.latestActivity = timestamp;
  }

  swapper.paused = event.params.paused;
  swapper.save();

  // TODO: Save event
}

export function handleOwnershipTransferred(event: OwnershipTransferred): void {
  let swapperId = event.address.toHexString();

  let swapper = getSwapper(swapperId);
  if (!swapper) return;

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber;
    swapper.latestActivity = timestamp;
  }

  let newOwner = event.params.newOwner.toHexString();
  createUserIfMissing(newOwner, blockNumber, timestamp);

  swapper.owner = newOwner;
  swapper.save();

  // TODO: Save event
}

export function handleExecCalls(event: ExecCalls): void {
  let swapperId = event.address.toHexString();

  let swapper = getSwapper(swapperId);
  if (!swapper) return;

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber;
    swapper.latestActivity = timestamp;
  }

  handleOwnerSwap(swapper, event);

  swapper.save();
}

export function handleFlash(event: Flash): void {
  let swapperId = event.address.toHexString();

  let swapper = getSwapper(swapperId);
  if (!swapper) return;

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  createTransactionIfMissing(txHash);
  let logIdx = event.logIndex;

  if (event.block.number.toI32() > swapper.latestBlock) {
    swapper.latestBlock = blockNumber;
    swapper.latestActivity = timestamp;
  }

  let tokenToBeneficiary = event.params.tokenToBeneficiary.toHexString();
  let amountsToBeneificiary = event.params.amountsToBeneficiary;
  let excessToBeneficiary = event.params.excessToBeneficiary;
  let quoteParams = event.params.quoteParams;

  for (let i: i32 = 0; i < quoteParams.length; i++) {
    let inputAmount = quoteParams[i].baseAmount;
    let outputAmount = amountsToBeneificiary[i];
    let inputTokenId = quoteParams[i].quotePair.base.toHexString();
    let token = new Token(inputTokenId);
    token.save();

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
    );
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
    );
  }

  swapper.save();

  // TODO: save event
}

function handleOwnerSwap(
  swapper: Swapper,
  event: ExecCalls,
): void {
  let swapperId = swapper.id;

  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  createTransactionIfMissing(txHash);
  let logIdx = event.logIndex;

  let receipt = event.receipt as ethereum.TransactionReceipt;
  if (receipt) {
    let receiptLogs = receipt.logs;
    let pendingInputToken = '';
    let pendingInputAmount = BigInt.fromI32(0);

    for (let i: i32 = 0; i < receiptLogs.length; i++) {
      let receiptLog = receiptLogs[i];
      let topic0 = receiptLog.topics[0].toHexString();
      if (topic0 == TRANSFER_EVENT_TOPIC) {
        let token = receiptLog.address.toHexString();
        let fromAddress = getAddressHexFromBytes32(receiptLog.topics[1].toHexString());
        let toAddress = getAddressHexFromBytes32(receiptLog.topics[2].toHexString());
        let amount = BigInt.fromUnsignedBytes(Bytes.fromUint8Array(receiptLog.data.reverse()));

        if (fromAddress == swapperId) {
          pendingInputToken = token;
          pendingInputAmount = amount;
        } else if (toAddress == swapperId) {
          updateSwapBalance(
            swapperId,
            swapper.beneficiary,
            pendingInputToken,
            pendingInputAmount,
            token,
            amount,
            timestamp,
            txHash,
            logIdx,
          );
        }
      } else if (topic0 == WETH_WITHDRAWAL_EVENT_TOPIC) {
        let amount = BigInt.fromUnsignedBytes(Bytes.fromUint8Array(receiptLog.data.reverse()));
        updateSwapBalance(
          swapperId,
          swapper.beneficiary,
          pendingInputToken,
          pendingInputAmount,
          ZERO_ADDRESS,
          amount,
          timestamp,
          txHash,
          logIdx,
        );
      }
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
  logIdx: BigInt
): void {
  let swapBalanceId = createJointId([swapperId, inputTokenId, outputTokenId]);
  let swapBalance = SwapBalance.load(swapBalanceId);
  if (!swapBalance) {
    swapBalance = new SwapBalance(swapBalanceId);
    swapBalance.swapper = swapperId;
    swapBalance.inputToken = inputTokenId;
    swapBalance.outputToken = outputTokenId;
    swapBalance.inputAmount = ZERO;
    swapBalance.outputAmount = ZERO;
  }
  swapBalance.inputAmount += inputAmount;
  swapBalance.outputAmount += outputAmount;
  swapBalance.save();

  // Only need to update withdrawn for users. For all modules, swapped funds
  // will show up in their active balances.
  let user = User.load(beneficiary);
  if (user) {
    let tokenBalanceId = createJointId([beneficiary, outputTokenId]);
    let tokenWithdrawalId = createJointId([
      TOKEN_WITHDRAWAL_USER_PREFIX,
      tokenBalanceId
    ]);
    let tokenWithdrawal = TokenWithdrawal.load(tokenWithdrawalId);
    if (!tokenWithdrawal) {
      tokenWithdrawal = new TokenWithdrawal(tokenWithdrawalId);
      tokenWithdrawal.account = beneficiary;
      tokenWithdrawal.token = outputTokenId;
      tokenWithdrawal.amount = ZERO;
    }
    tokenWithdrawal.amount += outputAmount;
    tokenWithdrawal.save();
  }

  // Save events
  let swapFundsEventId = createJointId([SWAP_FUNDS_EVENT_PREFIX, txHash, logIdx.toString()]);
  let swapFundsEvent = new SwapFundsEvent(swapFundsEventId);
  swapFundsEvent.timestamp = timestamp;
  swapFundsEvent.transaction = txHash;
  swapFundsEvent.logIndex = logIdx;
  swapFundsEvent.account = swapperId;
  swapFundsEvent.inputAmount = inputAmount;
  swapFundsEvent.inputToken = inputTokenId;
  swapFundsEvent.outputAmount = outputAmount;
  swapFundsEvent.outputToken = outputTokenId;
  swapFundsEvent.save();

  let receiveSwappedFundsEventId = createJointId([RECEIVE_PREFIX, SWAP_FUNDS_EVENT_PREFIX, txHash, logIdx.toString()]);
  let receiveSwappedFundsEvent = new ReceiveSwappedFundsEvent(receiveSwappedFundsEventId);
  receiveSwappedFundsEvent.timestamp = timestamp;
  receiveSwappedFundsEvent.logIndex = logIdx;
  receiveSwappedFundsEvent.account = beneficiary;
  receiveSwappedFundsEvent.swapFundsEvent = swapFundsEventId;
  receiveSwappedFundsEvent.save();
}

function createOracleIfMissing(
  oracleId: string,
): void {
  let oracle = Oracle.load(oracleId);
  if (!oracle) {
    oracle = new Oracle(oracleId);
    oracle.type = 'unknown';
  }
}

function getAddressHexFromBytes32(bytesAddress: string): string {
  let prefix = bytesAddress.slice(0, 2);
  let address = bytesAddress.slice(26);
  return prefix + address;
}

function updatePairOverride(
  swapperId: string,
  baseToken: string,
  quoteToken: string,
  scaledOfferFactor: BigInt,
): void {
  let pairOverrideId = createJointId([swapperId, baseToken, quoteToken]);
  let pairOverride = SwapperPairOverride.load(pairOverrideId);
  if (!pairOverride) {
    pairOverride = new SwapperPairOverride(pairOverrideId);
    pairOverride.swapper = swapperId;
    pairOverride.base = baseToken;
    pairOverride.quote = quoteToken;
  }
  pairOverride.scaledOfferFactor = scaledOfferFactor;
  pairOverride.save();
}
