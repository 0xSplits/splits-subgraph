import { BigInt, log } from "@graphprotocol/graph-ts";
import { CreateWaterfallModule } from "../generated/WaterfallModuleFactory/WaterfallModuleFactory";
import {
  WaterfallFunds,
  RecoverNonWaterfallFunds,
} from "../generated/templates/WaterfallModule/WaterfallModule";
import { WaterfallModule as WaterfallModuleTemplate } from "../generated/templates";
import {
  Token,
  User,
  WaterfallModule,
  WaterfallTranche,
  CreateWaterfallModuleEvent,
  WaterfallRecipientAddedEvent,
  WaterfallFundsEvent,
  ReceiveWaterfallFundsEvent,
  RecoverNonWaterfallFundsEvent,
  ReceiveNonWaterfallFundsEvent,
  TokenWithdrawal,
} from "../generated/schema";
import {
  ADDED_PREFIX,
  createJointId,
  createTransactionIfMissing,
  createUserIfMissing,
  getWaterfallModule,
  RECEIVE_PREFIX,
  TOKEN_WITHDRAWAL_USER_PREFIX
} from "./helpers";

export const ZERO = BigInt.fromI32(0);

const CREATE_WATERFALL_MODULE_EVENT_PREFIX = "cwme";
const WATERFALL_FUNDS_EVENT_PREFIX = "wfe";
const RECOVER_NON_WATERFALL_FUNDS_EVENT_PREFIX = "rnwfe";

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

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  createTransactionIfMissing(txHash);
  let logIdx = event.logIndex;

  let waterfallModule = new WaterfallModule(waterfallModuleId);

  let tokenId = event.params.token.toHexString();
  let token = new Token(tokenId);
  token.save();

  waterfallModule.token = tokenId;
  waterfallModule.nonWaterfallRecipient = event.params.nonWaterfallRecipient;
  waterfallModule.totalClaimedAmount = ZERO;
  waterfallModule.createdBlock = blockNumber;
  waterfallModule.latestBlock = blockNumber;
  waterfallModule.latestActivity = timestamp;

  let waterfallTrancheRecipients = event.params.recipients;
  let waterfallTrancheThresholds = event.params.thresholds;

  let previousThreshold = ZERO;
  let i: i32 = 0;
  for (; i < waterfallTrancheThresholds.length; i++) {
    let currentTrancheAmount = waterfallTrancheThresholds[i] - previousThreshold;
    let accountId = waterfallTrancheRecipients[i].toHexString();
    createWaterfallTranche(waterfallModuleId, blockNumber, timestamp, accountId, i.toString(), previousThreshold, currentTrancheAmount);
    saveWaterfallRecipientAddedEvent(timestamp, txHash, logIdx, accountId);

    previousThreshold = waterfallTrancheThresholds[i];
  }

  // One more create call for the residual recipient
  let accountId = waterfallTrancheRecipients[i].toHexString();
  createWaterfallTranche(waterfallModuleId, blockNumber, timestamp, accountId, i.toString(), previousThreshold);
  saveWaterfallRecipientAddedEvent(timestamp, txHash, logIdx, accountId);

  waterfallModule.save();
  WaterfallModuleTemplate.create(event.params.waterfallModule);

  // Save event
  let createWaterfallModuleEventId = createJointId([CREATE_WATERFALL_MODULE_EVENT_PREFIX, txHash, logIdx.toString()]);
  let createWaterfallModuleEvent = new CreateWaterfallModuleEvent(createWaterfallModuleEventId);
  createWaterfallModuleEvent.timestamp = timestamp;
  createWaterfallModuleEvent.transaction = txHash;
  createWaterfallModuleEvent.logIndex = logIdx;
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
    waterfallModule.latestActivity = event.block.timestamp;
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
      saveWaterfallRecipientReceivedFunds(
        timestamp,
        txHash,
        logIdx,
        waterfallModule.token,
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
  waterfallFundsEvent.logIndex = logIdx;
  waterfallFundsEvent.amount = totalPayout;
  waterfallFundsEvent.save();
}

export function handleRecoverNonWaterfallFunds(event: RecoverNonWaterfallFunds): void {
  let waterfallModuleId = event.address.toHexString();
  let waterfallModule = getWaterfallModule(waterfallModuleId);
  if (!waterfallModule) return;
  
  // Update latest block
  if (event.block.number.toI32() > waterfallModule.latestBlock) {
    waterfallModule.latestBlock = event.block.number.toI32();
    waterfallModule.latestActivity = event.block.timestamp;
    waterfallModule.save();
  }
  
  // Save events
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  createTransactionIfMissing(txHash);
  let logIdx = event.logIndex;

  let tokenId = event.params.nonWaterfallToken.toHexString();
  let token = new Token(tokenId);
  token.save();

  let recoverNonWaterfallFundsEventId = createJointId([RECOVER_NON_WATERFALL_FUNDS_EVENT_PREFIX, txHash, logIdx.toString()]);
  let recoverNonWaterfallFundsEvent = new RecoverNonWaterfallFundsEvent(recoverNonWaterfallFundsEventId);
  recoverNonWaterfallFundsEvent.timestamp = timestamp;
  recoverNonWaterfallFundsEvent.transaction = txHash;
  recoverNonWaterfallFundsEvent.account = waterfallModuleId;
  recoverNonWaterfallFundsEvent.logIndex = logIdx;
  recoverNonWaterfallFundsEvent.amount = event.params.amount;
  recoverNonWaterfallFundsEvent.nonWaterfallToken = tokenId;
  recoverNonWaterfallFundsEvent.save();

  let accountId = event.params.recipient.toHexString();
  let receiveNonWaterfallFundsEventId = createJointId([
    RECEIVE_PREFIX,
    recoverNonWaterfallFundsEventId,
    accountId
  ]);
  let receiveNonWaterfallFundsEvent = new ReceiveNonWaterfallFundsEvent(
    receiveNonWaterfallFundsEventId
  );
  receiveNonWaterfallFundsEvent.timestamp = timestamp;
  receiveNonWaterfallFundsEvent.account = accountId;
  receiveNonWaterfallFundsEvent.logIndex = logIdx;
  receiveNonWaterfallFundsEvent.recoverNonWaterfallFundsEvent = recoverNonWaterfallFundsEventId;
  receiveNonWaterfallFundsEvent.save();
}

function createWaterfallTranche(
  waterfallModuleId: string,
  blockNumber: i32,
  timestamp: BigInt,
  recipientAddress: string,
  tranchePosition: string,
  trancheStart: BigInt,
  trancheSize: BigInt | null = null
): void {
  let waterfallTrancheId = createJointId([waterfallModuleId, tranchePosition]);
  let waterfallTranche = new WaterfallTranche(waterfallTrancheId);

  waterfallTranche.account = waterfallModuleId;
  waterfallTranche.startAmount = trancheStart;
  if (trancheSize) {
    waterfallTranche.size = trancheSize;
  }
  waterfallTranche.claimedAmount = ZERO;

  createUserIfMissing(recipientAddress, blockNumber, timestamp);
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
  recipientAddedEvent.logIndex = logIdx;
  recipientAddedEvent.createWaterfallEvent = createWaterfallModuleEventId;
  recipientAddedEvent.save();
}

function saveWaterfallRecipientReceivedFunds(
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt,
  tokenId: string,
  accountId: string,
  amount: BigInt,
): void {
  // Only need to update withdrawn for users. For all modules, waterfall'd funds
  // will show up in their active balances.
  let user = User.load(accountId);
  if (user) {
    let tokenBalanceId = createJointId([accountId, tokenId]);
    let tokenWithdrawalId = createJointId([
      TOKEN_WITHDRAWAL_USER_PREFIX,
      tokenBalanceId
    ]);
    let tokenWithdrawal = TokenWithdrawal.load(tokenWithdrawalId);
    if (!tokenWithdrawal) {
      tokenWithdrawal = new TokenWithdrawal(tokenWithdrawalId);
      tokenWithdrawal.account = accountId;
      tokenWithdrawal.token = tokenId;
    }
    tokenWithdrawal.amount += amount;
    tokenWithdrawal.save();
  }

  // Save event
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
  receiveWaterfallFundsEvent.logIndex = logIdx;
  receiveWaterfallFundsEvent.amount = amount;
  receiveWaterfallFundsEvent.waterfallFundsEvent = waterfallFundsEventId;
  receiveWaterfallFundsEvent.save();
}
