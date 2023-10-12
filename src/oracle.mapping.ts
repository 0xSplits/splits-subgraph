import { Address, BigInt, Bytes, log } from '@graphprotocol/graph-ts'
import { CreateUniV3Oracle } from '../generated/UniV3OracleFactory/UniV3OracleFactory'
import { UniV3Pool as UniV3PoolContract } from '../generated/UniV3OracleFactory/UniV3Pool'
import {
  SetDefaultPeriod,
  SetPairDetails,
} from '../generated/templates/UniV3Oracle/UniV3Oracle'
import { UniV3Oracle as UniV3OracleTemplate } from '../generated/templates'
import {
  Token,
  User,
  Oracle,
  UniswapV3TWAPPairDetail,
} from '../generated/schema'
import {
  createJointId,
  createTransactionIfMissing,
  createUserIfMissing,
} from './helpers'

export const ZERO = BigInt.fromI32(0)

export function handleCreateUniV3Oracle(event: CreateUniV3Oracle): void {
  let oracleId = event.params.oracle.toHexString()

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
  let defaultPeriod = event.params.params.defaultPeriod
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
    let pool = pairDetail.pool
    let period = pairDetail.period

    // Store reverse pairing as well for easier lookup
    updatePairDetail(oracleId, base, quote, pool, period)
    updatePairDetail(oracleId, quote, base, pool, period)
  }

  oracle.type = 'uniswapV3TWAP'
  oracle.owner = owner
  oracle.paused = paused
  oracle.defaultPeriod = defaultPeriod

  oracle.createdBlock = blockNumber
  oracle.latestBlock = blockNumber
  oracle.latestActivity = timestamp

  oracle.save()
  UniV3OracleTemplate.create(event.params.oracle)

  // TODO: Save event?
}

function updatePairDetail(
  oracleId: string,
  baseToken: string,
  quoteToken: string,
  pool: Bytes,
  period: BigInt,
): void {
  let pairDetailId = createJointId([oracleId, baseToken, quoteToken])
  let pairDetail = UniswapV3TWAPPairDetail.load(pairDetailId)
  if (!pairDetail) {
    pairDetail = new UniswapV3TWAPPairDetail(pairDetailId)
    pairDetail.oracle = oracleId
    pairDetail.base = baseToken
    pairDetail.quote = quoteToken
  }
  pairDetail.pool = pool
  pairDetail.period = period

  // Fetch pool fee. Need to handle the case of a non-univ3 pool
  let uniV3PoolContract = UniV3PoolContract.bind(Address.fromBytes(pool))
  let feeCallResult = uniV3PoolContract.try_fee()
  let fee = 0
  if (!feeCallResult.reverted) {
    fee = feeCallResult.value
  }
  pairDetail.fee = fee

  pairDetail.save()
}

export function handleSetDefaultPeriod(event: SetDefaultPeriod): void {
  let oracleId = event.address.toHexString()

  let oracle = Oracle.load(oracleId)
  if (!oracle) return

  let blockNumber = event.block.number.toI32()
  let timestamp = event.block.timestamp

  if (event.block.number.toI32() > oracle.latestBlock) {
    oracle.latestBlock = blockNumber
    oracle.latestActivity = timestamp
  }

  oracle.defaultPeriod = event.params.defaultPeriod
  oracle.save()

  // TODO: Save event?
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

    let pool = pairDetails[i].pairDetail.pool
    let period = pairDetails[i].pairDetail.period

    // Store reverse pairing as well for easier lookup
    updatePairDetail(oracleId, base, quote, pool, period)
    updatePairDetail(oracleId, quote, base, pool, period)
  }

  oracle.save()

  // TODO: Save event?
}
