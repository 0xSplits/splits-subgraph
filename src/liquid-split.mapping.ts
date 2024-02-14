import { Address, BigInt, log, store } from '@graphprotocol/graph-ts'
import {
  CreateLS1155,
  CreateLS1155Clone,
} from '../generated/LiquidSplitFactory/LiquidSplitFactory'
import {
  CreateLiquidSplit,
  TransferSingle,
  FullLiquidSplit as LiquidSplitContract,
  TransferBatch,
  Transfer,
} from '../generated/LiquidSplit/FullLiquidSplit'
import {
  ChaosSplit,
  Transfer as TransferChaos,
} from '../generated/Chaos/ChaosSplit'
import { LiquidSplit as LiquidSplitTemplate } from '../generated/templates'
import {
  LiquidSplit,
  Holder,
  Split,
  User,
  CreateLiquidSplitEvent,
  LiquidSplitNFTTransferEvent,
  LiquidSplitNFTAddedEvent,
  LiquidSplitNFTRemovedEvent,
} from '../generated/schema'
import {
  ADDED_PREFIX,
  createJointId,
  createTransactionIfMissing,
  createUserIfMissing,
  getLiquidSplit,
  PERCENTAGE_SCALE,
  REMOVED_PREFIX,
  ZERO,
  ZERO_ADDRESS,
} from './helpers'

const FACTORY_GENERATED_TOTAL_SUPPLY = BigInt.fromI64(1e3 as i64)
const CHAOS_MULTIPLIER = BigInt.fromI64(1e6 as i64)
const CHAOS_TOTAL_SUPPLY = BigInt.fromI64(1e3 as i64)
const CREATE_LIQUID_SPLIT_EVENT_PREFIX = 'clse'
const TRANSFER_NFT_EVENT_PREFIX = 'tne'

export function handleCreateLiquidSplit(event: CreateLiquidSplit): void {
  // If the event has a payoutSplit arg and it's a valid split id, we're going to
  // assume it's a legit liquid split that is extending our abstract contract. If this
  // ever breaks, we'll need to update to verify that the contract has a valid
  // scaledPercentBalanceOf function.
  let txHash = event.transaction.hash.toHexString()

  let payoutSplitId = event.params.payoutSplit.toHexString()
  // Payout split already exists for these liquid splits, but not for the
  // CreateLS1155Clone event. Order of events determines processing order across
  // different data sources, and the clone event comes before the create split event
  // (but the CreateLiquidSplit event comes after).
  let payoutSplit = Split.load(payoutSplitId)
  if (!payoutSplit) return
  payoutSplit.parentEntityType = 'liquidSplit'
  payoutSplit.save()

  let isFactoryGenerated = false
  let isChaosSplit = false
  handleLiquidSplitCreation(
    event.address,
    isFactoryGenerated,
    event.block.timestamp,
    txHash,
    event.logIndex,
    event.block.number.toI32(),
    isChaosSplit,
  )
}

export function handleCreateLiquidSplitClone(event: CreateLS1155Clone): void {
  let isFactoryGenerated = true
  let isChaosSplit = false
  handleLiquidSplitCreation(
    event.params.ls,
    isFactoryGenerated,
    event.block.timestamp,
    event.transaction.hash.toHexString(),
    event.logIndex,
    event.block.number.toI32(),
    isChaosSplit,
  )
}

export function handleTransferSingle1155(event: TransferSingle): void {
  let liquidSplitId = event.address.toHexString()

  let liquidSplit = getLiquidSplit(liquidSplitId)
  if (!liquidSplit) return

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp

  let fromAddressString = event.params.from.toHexString()
  let toAddressString = event.params.to.toHexString()
  if (liquidSplit.isFactoryGenerated) {
    if (fromAddressString != ZERO_ADDRESS) {
      let fromHolder = getHolder(
        fromAddressString,
        liquidSplitId,
        blockNumber,
        timestamp,
      )
      fromHolder.ownership -=
        (event.params.amount * PERCENTAGE_SCALE) /
        FACTORY_GENERATED_TOTAL_SUPPLY
      fromHolder.save()
    }
    if (toAddressString != ZERO_ADDRESS) {
      let toHolder = getHolder(
        toAddressString,
        liquidSplitId,
        blockNumber,
        timestamp,
      )
      toHolder.ownership +=
        (event.params.amount * PERCENTAGE_SCALE) /
        FACTORY_GENERATED_TOTAL_SUPPLY
      toHolder.save()
    }
  } else {
    updateHolderOwnershipNonFactoryLiquidSplit(
      event.address,
      event.params.from,
      event.params.to,
      blockNumber,
      timestamp,
    )
  }

  // Save event
  saveTransferEvents(
    liquidSplitId,
    fromAddressString,
    toAddressString,
    event.params.amount,
    event.block.timestamp,
    event.transaction.hash.toHexString(),
    event.logIndex,
  )
}

export function handleTransferBatch1155(event: TransferBatch): void {
  let liquidSplitId = event.address.toHexString()

  let liquidSplit = getLiquidSplit(liquidSplitId)
  if (!liquidSplit) return

  let fromAddressString = event.params.from.toHexString()
  let toAddressString = event.params.to.toHexString()
  let totalAmount = BigInt.fromI64(0)
  for (let i: i32 = 0; i < event.params.amounts.length; i++) {
    totalAmount += event.params.amounts[i]
  }

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp
  if (liquidSplit.isFactoryGenerated) {
    if (fromAddressString != ZERO_ADDRESS) {
      let fromHolder = getHolder(
        fromAddressString,
        liquidSplitId,
        blockNumber,
        timestamp,
      )
      fromHolder.ownership -=
        (totalAmount * PERCENTAGE_SCALE) / FACTORY_GENERATED_TOTAL_SUPPLY
      fromHolder.save()
    }
    if (toAddressString != ZERO_ADDRESS) {
      let toHolder = getHolder(
        toAddressString,
        liquidSplitId,
        blockNumber,
        timestamp,
      )
      toHolder.ownership +=
        (totalAmount * PERCENTAGE_SCALE) / FACTORY_GENERATED_TOTAL_SUPPLY
      toHolder.save()
    }
  } else {
    updateHolderOwnershipNonFactoryLiquidSplit(
      event.address,
      event.params.from,
      event.params.to,
      blockNumber,
      timestamp,
    )
  }

  // Save event
  saveTransferEvents(
    liquidSplitId,
    fromAddressString,
    toAddressString,
    totalAmount,
    event.block.timestamp,
    event.transaction.hash.toHexString(),
    event.logIndex,
  )
}

export function handleTransferChaos721(event: TransferChaos): void {
  // Only the first 1000 tokens are part of the chaos liquid split
  let shouldSkip = event.params.tokenId > BigInt.fromI32(999)
  if (shouldSkip) return

  let liquidSplitId = event.address.toHexString()
  // Cant use getLiquidSplit because it will throw an error if it doesn't exist, which it won't
  // on the first execution of this.
  let liquidSplit = LiquidSplit.load(liquidSplitId)

  // Create liquid split if missing (only needed for first transfer event)
  if (!liquidSplit) {
    let isChaosSplit = true
    let isFactoryGenerated = false
    handleLiquidSplitCreation(
      event.address,
      isFactoryGenerated,
      event.block.timestamp,
      event.transaction.hash.toHexString(),
      event.logIndex,
      event.block.number.toI32(),
      isChaosSplit,
    )
  }

  // Handle transfer
  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp
  let chaosContract = ChaosSplit.bind(event.address)

  let fromAddressString = event.params.from.toHexString()
  if (fromAddressString != ZERO_ADDRESS) {
    let fromHolder = getHolder(
      fromAddressString,
      liquidSplitId,
      blockNumber,
      timestamp,
    )
    fromHolder.ownership =
      (chaosContract.superchargeBalances(event.params.from) *
        CHAOS_MULTIPLIER) /
      CHAOS_TOTAL_SUPPLY
    fromHolder.save()
  }

  let toAddressString = event.params.to.toHexString()
  if (toAddressString != ZERO_ADDRESS) {
    let toHolder = getHolder(
      toAddressString,
      liquidSplitId,
      blockNumber,
      timestamp,
    )
    toHolder.ownership =
      (chaosContract.superchargeBalances(event.params.to) * CHAOS_MULTIPLIER) /
      CHAOS_TOTAL_SUPPLY
    toHolder.save()
  }

  // Save event
  saveTransferEvents(
    liquidSplitId,
    fromAddressString,
    toAddressString,
    BigInt.fromI64(1),
    event.block.timestamp,
    event.transaction.hash.toHexString(),
    event.logIndex,
  )
}

export function handleTransfer721(event: Transfer): void {
  let liquidSplitId = event.address.toHexString()

  let liquidSplit = getLiquidSplit(liquidSplitId)
  if (!liquidSplit) return

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp

  updateHolderOwnershipNonFactoryLiquidSplit(
    event.address,
    event.params.from,
    event.params.to,
    blockNumber,
    timestamp,
  )

  // Save event
  saveTransferEvents(
    liquidSplitId,
    event.params.from.toHexString(),
    event.params.to.toHexString(),
    BigInt.fromI64(1),
    event.block.timestamp,
    event.transaction.hash.toHexString(),
    event.logIndex,
  )
}

function handleLiquidSplitCreation(
  liquidSplitAddress: Address,
  isFactoryGenerated: boolean,
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt,
  blockNumber: i32,
  isChaosSplit: boolean,
): void {
  let liquidSplitId = liquidSplitAddress.toHexString()
  createTransactionIfMissing(txHash)

  // If a user already exists at this id, just return for now. Cannot have two
  // entities with the same id if they share an interface. Will handle this situation
  // in subgraph v2.
  let liquidSplitUser = User.load(liquidSplitId)
  if (liquidSplitUser) {
    log.warning(
      'Trying to create a liquid split, but a user already exists: {}',
      [liquidSplitId],
    )
    return
  }

  let liquidSplit = new LiquidSplit(liquidSplitId)
  liquidSplit.type = 'liquidSplit'
  liquidSplit.createdBlock = blockNumber
  liquidSplit.latestBlock = blockNumber
  liquidSplit.latestActivity = timestamp
  liquidSplit.isFactoryGenerated = isFactoryGenerated

  // Fetch distributor fee and payout split
  let liquidSplitContract = LiquidSplitContract.bind(liquidSplitAddress)
  liquidSplit.distributorFee = liquidSplitContract.distributorFee()
  liquidSplit.split = liquidSplitContract.payoutSplit().toHexString()

  liquidSplit.save()
  if (!isChaosSplit) {
    // Don't need to create a template for chaos, tracking it's events manually
    LiquidSplitTemplate.create(liquidSplitAddress)
  }

  // Save event
  let createLiquidSplitEventId = createJointId([
    CREATE_LIQUID_SPLIT_EVENT_PREFIX,
    txHash,
    logIdx.toString(),
  ])
  let createLiquidSplitEvent = new CreateLiquidSplitEvent(
    createLiquidSplitEventId,
  )
  createLiquidSplitEvent.timestamp = timestamp
  createLiquidSplitEvent.transaction = txHash
  createLiquidSplitEvent.account = liquidSplitId
  createLiquidSplitEvent.logIndex = logIdx
  createLiquidSplitEvent.save()
}

function getHolder(
  accountId: string,
  liquidSplitId: string,
  blockNumber: i32,
  timestamp: BigInt,
): Holder {
  let holderId = createJointId([liquidSplitId, accountId])
  let holder = Holder.load(holderId)
  if (!holder) {
    createUserIfMissing(accountId, blockNumber, timestamp)
    holder = new Holder(holderId)
    holder.liquidSplit = liquidSplitId
    holder.account = accountId
    holder.ownership = ZERO
  }

  return holder
}

function updateHolderOwnershipNonFactoryLiquidSplit(
  liquidSplitAddress: Address,
  fromAddress: Address,
  toAddress: Address,
  blockNumber: i32,
  timestamp: BigInt,
): void {
  let liquidSplitContract = LiquidSplitContract.bind(liquidSplitAddress)
  let liquidSplitId = liquidSplitAddress.toHexString()

  let fromAddressString = fromAddress.toHexString()
  let toAddressString = toAddress.toHexString()

  if (fromAddressString == ZERO_ADDRESS || toAddressString == ZERO_ADDRESS) {
    // If it's a mint or burn, need to update all holders ownership
    if (fromAddressString != ZERO_ADDRESS) {
      let fromHolder = getHolder(fromAddressString, liquidSplitId, blockNumber, timestamp)
      let ownership = liquidSplitContract.scaledPercentBalanceOf(fromAddress)
      if (ownership == ZERO) {
        store.remove('Holder', fromHolder.id)
      } else {
        fromHolder.ownership = ownership
        fromHolder.save()
      }
    }
  
    if (toAddressString != ZERO_ADDRESS) {
      let toHolder = getHolder(toAddressString, liquidSplitId, blockNumber, timestamp)
      let ownership = liquidSplitContract.scaledPercentBalanceOf(toAddress)
      if (ownership == ZERO) {
        store.remove('Holder', toHolder.id)
      } else {
        toHolder.ownership = ownership
        toHolder.save()
      }
    }

    let liquidSplit = LiquidSplit.load(liquidSplitId) as LiquidSplit
    let holders = liquidSplit.holders.load()
    for (let i = 0; i < holders.length; i++) {
      let holder = holders[i]
      // Only update if it's not the from/to address (i.e. we haven't already updated it)
      if (holder.account != fromAddressString && holder.account != toAddressString) {
        holder.ownership = liquidSplitContract.scaledPercentBalanceOf(Address.fromString(holder.account))
        holder.save()
      }
    }
  } else {
    // if it's a transfer, just update the from/to ownership
    let fromHolder = getHolder(fromAddressString, liquidSplitId, blockNumber, timestamp)
    let fromOwnership = liquidSplitContract.scaledPercentBalanceOf(fromAddress)
    if (fromOwnership == ZERO) {
      store.remove('Holder', fromHolder.id)
    } else {
      fromHolder.ownership = fromOwnership
      fromHolder.save()
    }
  
    let toHolder = getHolder(toAddressString, liquidSplitId, blockNumber, timestamp)
    let toOwnership = liquidSplitContract.scaledPercentBalanceOf(toAddress)
    if (toOwnership == ZERO) {
      store.remove('Holder', toHolder.id)
    } else {
      toHolder.ownership = toOwnership
      toHolder.save()
    }
  }
}

function saveTransferEvents(
  liquidSplitId: string,
  fromAddress: string,
  toAddress: string,
  amount: BigInt | null,
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt,
): void {
  createTransactionIfMissing(txHash)

  let nftTransferEventId = createJointId([
    TRANSFER_NFT_EVENT_PREFIX,
    txHash,
    logIdx.toString(),
  ])
  let nftTransferEvent = new LiquidSplitNFTTransferEvent(nftTransferEventId)
  nftTransferEvent.timestamp = timestamp
  nftTransferEvent.transaction = txHash
  nftTransferEvent.account = liquidSplitId
  nftTransferEvent.logIndex = logIdx
  nftTransferEvent.transferType = getTransferType(fromAddress, toAddress)
  if (amount) {
    nftTransferEvent.amount = amount
  }
  nftTransferEvent.save()

  if (toAddress != ZERO_ADDRESS) {
    let nftAddedEventId = createJointId([ADDED_PREFIX, nftTransferEventId])
    let nftAddedEvent = new LiquidSplitNFTAddedEvent(nftAddedEventId)
    nftAddedEvent.timestamp = timestamp
    nftAddedEvent.account = toAddress
    nftAddedEvent.logIndex = logIdx
    nftAddedEvent.nftTransferEvent = nftTransferEventId
    nftAddedEvent.save()
  }

  if (fromAddress != ZERO_ADDRESS) {
    let nftRemovedEventId = createJointId([REMOVED_PREFIX, nftTransferEventId])
    let nftRemovedEvent = new LiquidSplitNFTRemovedEvent(nftRemovedEventId)
    nftRemovedEvent.timestamp = timestamp
    nftRemovedEvent.account = fromAddress
    nftRemovedEvent.logIndex = logIdx
    nftRemovedEvent.nftTransferEvent = nftTransferEventId
    nftRemovedEvent.save()
  }
}

function getTransferType(fromAddress: string, toAddress: string): string {
  if (fromAddress == ZERO_ADDRESS) {
    return 'mint'
  }
  if (toAddress === ZERO_ADDRESS) {
    return 'burn'
  }

  return 'transfer'
}
