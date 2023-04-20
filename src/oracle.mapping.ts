import { BigInt, log } from "@graphprotocol/graph-ts";
import { CreateUniV3Oracle } from "../generated/UniV3OracleFactory/UniV3OracleFactory"
import { SetDefaultFee, SetDefaultPeriod, SetDefaultScaledOfferFactor, SetPairOverrides } from "../generated/templates/UniV3Oracle/UniV3Oracle"
import { UniV3Oracle as UniV3OracleTemplate } from "../generated/templates";
import {
  Token,
  User,
  Oracle,
  UniswapV3TWAPPairOverride,
} from "../generated/schema";
import {
  createJointId,
  createTransactionIfMissing,
  createUserIfMissing,
} from "./helpers";

export const ZERO = BigInt.fromI32(0);

export function handleCreateUniV3Oracle(event: CreateUniV3Oracle): void {
  let oracleId = event.params.oracle.toHexString();

  // If a user already exists at this id, just return for now. Cannot have two
  // entities with the same id if they share an interface. Will handle this situation
  // in subgraph v2.
  let oracleUser = User.load(oracleId);
  if (oracleUser) {
    log.warning('Trying to create an oracle, but a user already exists: {}', [oracleId]);
    return;
  }

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;

  let oracle = new Oracle(oracleId);

  let owner = event.params.params.owner.toHexString();
  let paused = event.params.params.paused;
  let defaultFee = BigInt.fromI32(event.params.params.defaultFee);
  let defaultPeriod = event.params.params.defaultPeriod;
  let defaultScaledOfferFactor = event.params.params.defaultScaledOfferFactor;
  let pairOverrides = event.params.params.pairOverrides;

  createUserIfMissing(owner, blockNumber, timestamp);

  for (let i: i32 = 0; i < pairOverrides.length; i++) {
    let quotePair = pairOverrides[i].quotePair;

    let base = quotePair.base.toHexString();
    let baseToken = new Token(base);
    baseToken.save();


    let quote = quotePair.quote.toHexString();
    let quoteToken = new Token(quote);
    quoteToken.save();

    let pairOverride = pairOverrides[i].pairOverride;
    let fee = BigInt.fromI32(pairOverride.fee);
    let period = pairOverride.period;
    let scaledOfferFactor = pairOverride.scaledOfferFactor;

    updatePairOverride(oracleId, base, quote, fee, period, scaledOfferFactor);
  }

  oracle.type = "uniswapV3TWAP";
  oracle.owner = owner;
  oracle.paused = paused;
  oracle.defaultFee = defaultFee;
  oracle.defaultPeriod = defaultPeriod;
  oracle.defaultScaledOfferFactor = defaultScaledOfferFactor;

  oracle.createdBlock = blockNumber;
  oracle.latestBlock = blockNumber;
  oracle.latestActivity = timestamp;

  oracle.save();
  UniV3OracleTemplate.create(event.params.oracle);

  // TODO: Save event?
}

function updatePairOverride(
  oracleId: string,
  baseToken: string,
  quoteToken: string,
  fee: BigInt,
  period: BigInt,
  scaledOfferFactor: BigInt
): void {
  let pairOverrideId = createJointId([oracleId, baseToken, quoteToken]);
  let pairOverride = UniswapV3TWAPPairOverride.load(pairOverrideId);
  if (!pairOverride) {
    pairOverride = new UniswapV3TWAPPairOverride(pairOverrideId);
    pairOverride.oracle = oracleId;
    pairOverride.base = baseToken;
    pairOverride.quote = quoteToken;
  }
  pairOverride.fee = fee;
  pairOverride.period = period;
  pairOverride.scaledOfferFactor = scaledOfferFactor;
  pairOverride.save();
}

export function handleSetDefaultFee(event: SetDefaultFee): void {
  let oracleId = event.address.toHexString();

  let oracle = Oracle.load(oracleId);
  if (!oracle) return;

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;

  if (event.block.number.toI32() > oracle.latestBlock) {
    oracle.latestBlock = blockNumber;
    oracle.latestActivity = timestamp;
  }

  oracle.defaultFee = BigInt.fromI32(event.params.defaultFee);
  oracle.save();

  // TODO: Save event?
}

export function handleSetDefaultPeriod(event: SetDefaultPeriod): void {
  let oracleId = event.address.toHexString();

  let oracle = Oracle.load(oracleId);
  if (!oracle) return;

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;

  if (event.block.number.toI32() > oracle.latestBlock) {
    oracle.latestBlock = blockNumber;
    oracle.latestActivity = timestamp;
  }

  oracle.defaultPeriod = event.params.defaultPeriod;
  oracle.save();

  // TODO: Save event?
}

export function handleSetDefaultScaledOfferFactor(event: SetDefaultScaledOfferFactor): void {
  let oracleId = event.address.toHexString();

  let oracle = Oracle.load(oracleId);
  if (!oracle) return;

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;

  if (event.block.number.toI32() > oracle.latestBlock) {
    oracle.latestBlock = blockNumber;
    oracle.latestActivity = timestamp;
  }

  oracle.defaultScaledOfferFactor = event.params.defaultScaledOfferFactor;
  oracle.save();

  // TODO: Save event?
}

export function handleSetPairOverrides(event: SetPairOverrides): void {
  let oracleId = event.address.toHexString();

  let oracle = Oracle.load(oracleId);
  if (!oracle) return;

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;

  if (event.block.number.toI32() > oracle.latestBlock) {
    oracle.latestBlock = blockNumber;
    oracle.latestActivity = timestamp;
  }

  let pairOverrides = event.params.params
  for (let i: i32 = 0; i < pairOverrides.length; i++) {
    let base = pairOverrides[i].quotePair.base.toHexString();
    let baseToken = new Token(base);
    baseToken.save();

    let quote = pairOverrides[i].quotePair.quote.toHexString();
    let quoteToken = new Token(quote);
    quoteToken.save();

    let fee = BigInt.fromI32(pairOverrides[i].pairOverride.fee);
    let period = pairOverrides[i].pairOverride.period;
    let scaledOfferFactor = pairOverrides[i].pairOverride.scaledOfferFactor;

    updatePairOverride(oracleId, base, quote, fee, period, scaledOfferFactor);
  }

  oracle.save();

  // TODO: Save event?
}
