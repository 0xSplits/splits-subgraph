import { BigInt, log } from "@graphprotocol/graph-ts";
import { CreateWaterfallModule } from "../generated/WaterfallModuleFactory/WaterfallModuleFactory";
import {
  WaterfallFunds,
  RecoverNonWaterfallFunds,
} from "../generated/WaterfallModule/WaterfallModule";
// import {
//   Token,
//   Transaction,
//   VestingModule,
//   VestingStream,
//   CreateVestingModuleEvent,
//   CreateVestingStreamEvent,
//   ReleaseVestingFundsEvent,
// } from "../generated/schema";
import {
  Token,
  User,
  WaterfallModule,
  WaterfallTranche,
} from "../generated/schema";
import { createJointId, createUserIfMissing } from "./helpers";

export const ZERO = BigInt.fromI32(0);

// export const CREATE_VESTING_MODULE_EVENT_PREFIX = "cvme";
// export const CREATE_VESTING_STREAM_EVENT_PREFIX = "cvse";
// export const RELEASE_VESTING_FUNDS_EVENT_PREFIX = "rvfe";

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
    createWaterfallTranche(waterfallModuleId, waterfallTrancheRecipients[i].toHexString(), i.toString(), previousThreshold, currentTrancheAmount);

    previousThreshold = waterfallTrancheThresholds[i];
  }

  // One more create call for the residual recipient
  createWaterfallTranche(waterfallModuleId, waterfallTrancheRecipients[i].toHexString(), i.toString(), previousThreshold);

  waterfallModule.save();

  // Save event
  // let timestamp = event.block.timestamp;
  // let txHash = event.transaction.hash.toHexString();
  // createTransactionIfMissing(txHash);
  // let logIdx = event.logIndex;

  // let createVestingModuleEventId = createJointId([CREATE_VESTING_MODULE_EVENT_PREFIX, txHash, logIdx.toString()]);
  // let createVestingModuleEvent = new CreateVestingModuleEvent(createVestingModuleEventId);
  // createVestingModuleEvent.timestamp = timestamp;
  // createVestingModuleEvent.transaction = txHash;
  // createVestingModuleEvent.account = vestingModuleId;
  // createVestingModuleEvent.save();
}

export function handleWaterfallFunds(event: WaterfallFunds): void {
  let waterfallModuleId = event.address.toHexString();

  // must exist
  let waterfallModule = WaterfallModule.load(waterfallModuleId) as WaterfallModule;
  if (event.block.number.toI32() > waterfallModule.latestBlock) {
    waterfallModule.latestBlock = event.block.number.toI32();
  }

  let payoutAmounts = event.params.payouts;
  let remainingPayout = ZERO;
  for (let i: i32 = 0; i < payoutAmounts.length; i++) {
    // TODO: Need to convert?
    remainingPayout += payoutAmounts[i];
  }
  waterfallModule.totalClaimedAmount += remainingPayout;

  let i: i32 = 0;
  while (remainingPayout > ZERO) {
    let waterfallTrancheId = createJointId([waterfallModuleId, i.toString()]);
    let waterfallTranche = WaterfallTranche.load(waterfallTrancheId) as WaterfallTranche;
    i++;

    let oldRemainingPayout = remainingPayout;
    remainingPayout = updateWaterfallTrancheAmount(waterfallTranche, remainingPayout);

    // Nothing to save if the remaining payout didn't change, just skipped a filled tranche
    if (oldRemainingPayout !== remainingPayout) {
      waterfallTranche.save();
    }
  }

  waterfallModule.save();

  // TODO: Events
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

// function createTransactionIfMissing(txHash: string): void {
//   let tx = Transaction.load(txHash);
//   if (!tx) {
//     tx = new Transaction(txHash);
//     tx.save();
//   }
// }
