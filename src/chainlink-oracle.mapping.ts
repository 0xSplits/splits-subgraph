import { Address, BigInt, Bytes, log } from '@graphprotocol/graph-ts'
import { CreateChainlinkOracle } from '../generated/ChainlinkOracleFactory/ChainlinkOracleFactory'
import { ChainlinkOracle } from '../generated/ChainlinkOracleFactory/ChainlinkOracle'
import {
  OwnershipTransferred,
  SetPairDetails,
  SetPaused,
} from '../generated/templates/ChainlinkOracle/ChainlinkOracle'
import { ChainlinkOracle as ChainlinkOracleTemplate } from '../generated/templates'
import {
  Token,
  User,
  ChainlinkOracle as Oracle,
  ChainlinkPairDetail,
  ChainlinkFeed,
} from '../generated/schema'
import {
  createJointId,
  createUserIfMissing,
  getBigIntFromString,
} from './helpers'

export const ZERO = BigInt.fromI32(0)

const FEED_SIZE = 50

export function handleCreateChainlinkOracle(
  event: CreateChainlinkOracle,
): void {
  let oracleId = event.params.oracle.toHexString()
  log.info('oracleId: {}', [oracleId])

  // If a user already exists at this id, just return for now. Cannot have two
  // entities with the same id if they share an interface. Will handle this situation
  // in subgraph v2.
  let oracleUser = User.load(oracleId)
  if (oracleUser) {
    log.warning('Trying to create an oracle, but a user already exists: {}', [
      oracleId,
    ])
    return
  }

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp
  let oracle = new Oracle(oracleId)

  let owner = event.params.params.owner.toHexString()
  let paused = event.params.params.paused
  let pairDetails = event.params.params.pairDetails

  createUserIfMissing(owner, blockNumber, timestamp)

  for (let i: i32 = 0; i < pairDetails.length; i++) {
    let quotePair = pairDetails[i].quotePair

    let base = quotePair.base.toHexString()
    let baseToken = new Token(base)
    baseToken.save()

    let quote = quotePair.quote.toHexString()
    let quoteToken = new Token(quote)
    quoteToken.save()

    let pairDetail = pairDetails[i].pairDetail
    let path = pairDetail.path
    let inverted = pairDetail.inverted

    // Store reverse pairing as well for easier lookup
    updatePairDetail(oracleId, base, quote, path, inverted)
    updatePairDetail(oracleId, quote, base, path, !inverted)
  }

  oracle.type = 'chainlink'
  oracle.owner = owner
  oracle.paused = paused

  oracle.createdBlock = blockNumber
  oracle.latestBlock = blockNumber
  oracle.latestActivity = timestamp

  let sequencerFeedCall = ChainlinkOracle.bind(
    event.params.oracle,
  ).try_sequencerFeed()
  if (!sequencerFeedCall.reverted) {
    oracle.sequencerFeed = sequencerFeedCall.value
  }

  oracle.save()

  ChainlinkOracleTemplate.create(event.params.oracle)
}

function updatePairDetail(
  oracleId: string,
  baseToken: string,
  quoteToken: string,
  path: Bytes,
  inverted: boolean,
): void {
  let pairDetailId = createJointId([oracleId, baseToken, quoteToken])
  let pairDetail = ChainlinkPairDetail.load(pairDetailId)
  if (!pairDetail) {
    pairDetail = new ChainlinkPairDetail(pairDetailId)
    pairDetail.oracle = oracleId
    pairDetail.base = baseToken
    pairDetail.quote = quoteToken
  }
  pairDetail.inverted = inverted

  let pathAsString = path.toHex()
  let numberOfFeeds = pathAsString.length / FEED_SIZE

  for (let i = 0; i < numberOfFeeds; i++) {
    let feed = pathAsString.slice(FEED_SIZE * i, FEED_SIZE * (i + 1) + 2)
    createChainlinkFeed(feed, pairDetailId, oracleId, baseToken, quoteToken)
  }
  pairDetail.save()
}

function createChainlinkFeed(
  feed: string,
  pairDetailId: string,
  oracle: string,
  base: string,
  quote: string,
): ChainlinkFeed {
  /// decoding feed address from first 42 characters
  let feedAddress = Address.fromHexString(feed.slice(0, 42))

  /// decoding feed staleAfter from next 6 characters
  let staleAfter = getBigIntFromString(feed, 42, 48)

  /// decoding feed decimals from next 2 characters
  let decimals = getBigIntFromString(feed, 48, 50)

  /// decoding feed operation from last 2 characters
  let mul = getBigIntFromString(feed, 50, 52) == BigInt.fromI32(1)

  let feedId = createJointId([oracle, base, quote, feedAddress.toHexString()])
  let chainlinkFeed = ChainlinkFeed.load(feedId)
  if (!chainlinkFeed) {
    chainlinkFeed = new ChainlinkFeed(feedId)
    chainlinkFeed.aggregatorV3 = feedAddress
    chainlinkFeed.decimals = decimals
    chainlinkFeed.staleAfter = staleAfter
    chainlinkFeed.mul = mul
    chainlinkFeed.chainlinkPairDetail = pairDetailId
  } else {
    chainlinkFeed.aggregatorV3 = feedAddress
    chainlinkFeed.decimals = decimals
    chainlinkFeed.staleAfter = staleAfter
    chainlinkFeed.mul = mul
  }
  chainlinkFeed.save()

  return chainlinkFeed
}

export function handleSetPairDetails(event: SetPairDetails): void {
  let oracleId = event.address.toHexString()

  let oracle = Oracle.load(oracleId)
  if (!oracle) return

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp

  if (event.block.number.toI32() > oracle.latestBlock) {
    oracle.latestBlock = blockNumber
    oracle.latestActivity = timestamp
  }

  let pairDetails = event.params.params
  for (let i: i32 = 0; i < pairDetails.length; i++) {
    let base = pairDetails[i].quotePair.base.toHexString()
    let baseToken = new Token(base)
    baseToken.save()

    let quote = pairDetails[i].quotePair.quote.toHexString()
    let quoteToken = new Token(quote)
    quoteToken.save()

    let inverted = pairDetails[i].pairDetail.inverted
    let path = pairDetails[i].pairDetail.path

    // Store reverse pairing as well for easier lookup
    updatePairDetail(oracleId, base, quote, path, inverted)
    updatePairDetail(oracleId, quote, base, path, inverted)
  }

  oracle.save()
}

export function handleSetPaused(event: SetPaused): void {
  let oracleId = event.address.toHexString()

  let oracle = Oracle.load(oracleId)
  if (!oracle) return

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp

  if (event.block.number.toI32() > oracle.latestBlock) {
    oracle.latestBlock = blockNumber
    oracle.latestActivity = timestamp
  }

  oracle.paused = event.params.paused
  oracle.save()
}

export function handleOwnershipTransferred(event: OwnershipTransferred): void {
  let oracleId = event.address.toHexString()

  let oracle = Oracle.load(oracleId)
  if (!oracle) return

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp

  if (event.block.number.toI32() > oracle.latestBlock) {
    oracle.latestBlock = blockNumber
    oracle.latestActivity = timestamp
  }

  let newOwner = event.params.newOwner.toHexString()
  createUserIfMissing(newOwner, blockNumber, timestamp)

  oracle.owner = newOwner
  oracle.save()
}
