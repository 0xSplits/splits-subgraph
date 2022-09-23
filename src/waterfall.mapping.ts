import { BigInt, log } from "@graphprotocol/graph-ts";
import { CreateWaterfallModule } from "../generated/WaterfallModuleFactory/WaterfallModuleFactory";
import {
  WaterfallFunds,
  RecoverNonWaterfallFunds,
} from "../generated/WaterfallModule/WaterfallModule";
import {
  Token,
  User,
  WaterfallModule,
  WaterfallTranche,
  CreateWaterfallModuleEvent,
  WaterfallRecipientAddedEvent,
  WaterfallFundsEvent,
  ReceiveWaterfallFundsEvent,
} from "../generated/schema";
import { ADDED_PREFIX, createJointId, createTransactionIfMissing, createUserIfMissing, getWaterfallModule, RECEIVE_PREFIX } from "./helpers";

export const ZERO = BigInt.fromI32(0);

export const CREATE_WATERFALL_MODULE_EVENT_PREFIX = "cwme";
export const WATERFALL_FUNDS_EVENT_PREFIX = "wfe";

export function handleCreateWaterfallModule(event: CreateWaterfallModule): void {
  // Save module
  let waterfallModuleId = event.params.waterfallModule.toHexString();

  // If a user already exists at this id, just return for now. Cannot have two
  // entities with the same id if they share an interface. Will handle this situation
  // in subgraph v2.
  let waterfallUser = User.load(waterfallModuleId);
  if (waterfallUser) {
    log.warning('Trying to create a waterfall, but a user already exists: {}', [waterfallModuleId]);
    return;
  }

  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  createTransactionIfMissing(txHash);
  let logIdx = event.logIndex;

  let waterfallModule = new WaterfallModule(waterfallModuleId);

  let tokenId = event.params.token.toHexString();
  let token = new Token(tokenId);
  token.save();

  waterfallModule.token = tokenId;
  waterfallModule.totalClaimedAmount = ZERO;
  waterfallModule.latestBlock = event.block.number.toI32();

  let waterfallTrancheRecipients = event.params.recipients;
  let waterfallTrancheThresholds = event.params.thresholds;

  let previousThreshold = ZERO;
  let i: i32 = 0;
  for (; i < waterfallTrancheThresholds.length; i++) {
    let currentTrancheAmount = waterfallTrancheThresholds[i] - previousThreshold;
    let accountId = waterfallTrancheRecipients[i].toHexString();
    createWaterfallTranche(waterfallModuleId, accountId, i.toString(), previousThreshold, currentTrancheAmount);
    saveWaterfallRecipientAddedEvent(timestamp, txHash, logIdx, accountId);

    previousThreshold = waterfallTrancheThresholds[i];
  }

  // One more create call for the residual recipient
  let accountId = waterfallTrancheRecipients[i].toHexString();
  createWaterfallTranche(waterfallModuleId, accountId, i.toString(), previousThreshold);
  saveWaterfallRecipientAddedEvent(timestamp, txHash, logIdx, accountId);

  waterfallModule.save();

  // Save event
  let createWaterfallModuleEventId = createJointId([CREATE_WATERFALL_MODULE_EVENT_PREFIX, txHash, logIdx.toString()]);
  let createWaterfallModuleEvent = new CreateWaterfallModuleEvent(createWaterfallModuleEventId);
  createWaterfallModuleEvent.timestamp = timestamp;
  createWaterfallModuleEvent.transaction = txHash;
  createWaterfallModuleEvent.account = waterfallModuleId;
  createWaterfallModuleEvent.save();
}

export function handleWaterfallFunds(event: WaterfallFunds): void {
  let waterfallModuleId = event.address.toHexString();

  let waterfallModule = getWaterfallModule(waterfallModuleId);
  if (!waterfallModule) return;

  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  createTransactionIfMissing(txHash);
  let logIdx = event.logIndex;

  if (event.block.number.toI32() > waterfallModule.latestBlock) {
    waterfallModule.latestBlock = event.block.number.toI32();
  }

  let payoutAmounts = event.params.payouts;
  let remainingPayout = ZERO;
  for (let i: i32 = 0; i < payoutAmounts.length; i++) {
    remainingPayout += payoutAmounts[i];
  }
  let totalPayout = remainingPayout;
  waterfallModule.totalClaimedAmount += remainingPayout;

  let i: i32 = 0;
  while (remainingPayout > ZERO) {
    let waterfallTrancheId = createJointId([waterfallModuleId, i.toString()]);
    let waterfallTranche = WaterfallTranche.load(waterfallTrancheId) as WaterfallTranche;
    i++;

    let oldRemainingPayout = remainingPayout;
    remainingPayout = updateWaterfallTrancheAmount(waterfallTranche, remainingPayout);

    // Nothing to save if the remaining payout didn't change, just skipped a filled tranche
    if (!oldRemainingPayout.equals(remainingPayout)) {
      let recipientPayout = oldRemainingPayout.minus(remainingPayout)
      saveWaterfallRecipientReceivedFundsEvent(
        timestamp,
        txHash,
        logIdx,
        waterfallTranche.recipient,
        recipientPayout,
      )
      waterfallTranche.save();
    }
  }

  waterfallModule.save();

  // Save event
  let waterfallFundsEventId = createJointId([WATERFALL_FUNDS_EVENT_PREFIX, txHash, logIdx.toString()]);
  let waterfallFundsEvent = new WaterfallFundsEvent(waterfallFundsEventId);
  waterfallFundsEvent.timestamp = timestamp;
  waterfallFundsEvent.transaction = txHash;
  waterfallFundsEvent.account = waterfallModuleId;
  waterfallFundsEvent.amount = totalPayout;
  waterfallFundsEvent.save();
}

export function handleRecoverNonWaterfallFunds(event: RecoverNonWaterfallFunds): void {

}

function createWaterfallTranche(waterfallModuleId: string, recipientAddress: string, tranchePosition: string, trancheStart: BigInt, trancheSize: BigInt | null = null): void {
  let waterfallTrancheId = createJointId([waterfallModuleId, tranchePosition]);
  let waterfallTranche = new WaterfallTranche(waterfallTrancheId);

  waterfallTranche.account = waterfallModuleId;
  waterfallTranche.startAmount = trancheStart;
  if (trancheSize) {
    waterfallTranche.size = trancheSize;
  }
  waterfallTranche.claimedAmount = ZERO;

  createUserIfMissing(recipientAddress);
  waterfallTranche.recipient = recipientAddress;

  waterfallTranche.save();
}

// returns the new remaining payout
function updateWaterfallTrancheAmount(waterfallTranche: WaterfallTranche, remainingPayout: BigInt): BigInt {
  if (!waterfallTranche.size) {
    // It's the residual
    waterfallTranche.claimedAmount += remainingPayout;
    return ZERO;
  }

  if (waterfallTranche.size === waterfallTranche.claimedAmount) {
    // Tranche is already filled
    return remainingPayout;
  }

  let trancheFundsRemaining = waterfallTranche.size - waterfallTranche.claimedAmount;
  if (trancheFundsRemaining >= remainingPayout) {
    // The current tranche can take the rest of the payout
    waterfallTranche.claimedAmount += remainingPayout;
    return ZERO;
  }

  // Fill the current tranche and continue to the next one
  waterfallTranche.claimedAmount += trancheFundsRemaining;
  return remainingPayout - trancheFundsRemaining;
}

function saveWaterfallRecipientAddedEvent(
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt,
  accountId: string,
): void {
  let createWaterfallModuleEventId = createJointId([CREATE_WATERFALL_MODULE_EVENT_PREFIX, txHash, logIdx.toString()]);

  let recipientAddedEventId = createJointId([ADDED_PREFIX, createWaterfallModuleEventId, accountId]);
  let recipientAddedEvent = new WaterfallRecipientAddedEvent(recipientAddedEventId);
  recipientAddedEvent.timestamp = timestamp;
  recipientAddedEvent.account = accountId;
  recipientAddedEvent.createWaterfallEvent = createWaterfallModuleEventId;
  recipientAddedEvent.save();
}

function saveWaterfallRecipientReceivedFundsEvent(
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt,
  accountId: string,
  amount: BigInt,
): void {
  let waterfallFundsEventId = createJointId([WATERFALL_FUNDS_EVENT_PREFIX, txHash, logIdx.toString()]);
  let receiveWaterfallFundsEventId = createJointId([
    RECEIVE_PREFIX,
    waterfallFundsEventId,
    accountId
  ]);
  let receiveWaterfallFundsEvent = new ReceiveWaterfallFundsEvent(
    receiveWaterfallFundsEventId
  );
  receiveWaterfallFundsEvent.timestamp = timestamp;
  receiveWaterfallFundsEvent.account = accountId;
  receiveWaterfallFundsEvent.amount = amount;
  receiveWaterfallFundsEvent.waterfallFundsEvent = waterfallFundsEventId;
  receiveWaterfallFundsEvent.save();
}
