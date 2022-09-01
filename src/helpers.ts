import { BigInt, Address } from "@graphprotocol/graph-ts";
import {
  Split,
  Recipient,
  Token,
  TokenInternalBalance,
  TokenWithdrawal,
  User,
  Transaction,
  SetSplitEvent,
  DistributionEvent,
  DistributeDistributionEvent,
  ControlTransferEvent,
  FromUserControlTransferEvent,
  ToUserControlTransferEvent,
  ReceiveDistributionEvent,
  RecipientAddedEvent,
  RecipientRemovedEvent,
  TokenWithdrawalEvent,
  WithdrawalEvent,
  WaterfallModule,
  VestingModule,
} from "../generated/schema";

export const PERCENTAGE_SCALE = BigInt.fromI64(1e6 as i64);
export const ZERO = BigInt.fromI32(0);
export const ONE = BigInt.fromI32(1);

export const SET_SPLIT_EVENT_PREFIX = "sse";
export const ADDED_PREFIX = "add";
export const REMOVED_PREFIX = "rem";
export const RECEIVE_PREFIX = "rec";
export const DISTRIBUTE_PREFIX = "d";
export const DISTRIBUTION_EVENT_PREFIX = "de";
export const TOKEN_PREFIX = "t";
export const WITHDRAWAL_EVENT_PREFIX = "we";
export const TOKEN_WITHDRAWAL_SPLIT_PREFIX = "w-s";
export const TOKEN_WITHDRAWAL_USER_PREFIX = "w-u";
export const TOKEN_INTERNAL_BALANCE_PREFIX = "ib";
export const CONTROL_TRANSFER_EVENT_PREFIX = "ct";
export const FROM_USER_PREFIX = "fu";
export const TO_USER_PREFIX = "tu";
export const ID_SEPARATOR = "-";

export function createJointId(args: Array<string>): string {
  return args.join(ID_SEPARATOR);
}

function addBalanceToUser(
  accountId: string,
  tokenId: string,
  amount: BigInt
): void {
  let accountTokenInternalBalanceId = createJointId([
    TOKEN_INTERNAL_BALANCE_PREFIX,
    accountId,
    tokenId
  ]);
  let accountTokenInternalBalance = TokenInternalBalance.load(
    accountTokenInternalBalanceId
  );
  if (!accountTokenInternalBalance) {
    accountTokenInternalBalance = new TokenInternalBalance(
      accountTokenInternalBalanceId
    );
    accountTokenInternalBalance.account = accountId;
    accountTokenInternalBalance.token = tokenId;
  }
  accountTokenInternalBalance.amount += amount;
  accountTokenInternalBalance.save();
}

export function saveSetSplitEvent(
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt,
  splitId: string,
  type: string,
): void {
  let tx = Transaction.load(txHash);
  if (!tx) tx = new Transaction(txHash);
  let setSplitEvents = tx.setSplitEvents;
  if (!setSplitEvents) setSplitEvents = new Array<string>();

  let setSplitEventId = createJointId([SET_SPLIT_EVENT_PREFIX, txHash, logIdx.toString()]);
  let setEvent = new SetSplitEvent(setSplitEventId);
  setEvent.timestamp = timestamp;
  setEvent.transaction = txHash;
  setEvent.logIndex = logIdx;
  setEvent.account = splitId;
  setEvent.type = type;
  setEvent.save();
  setSplitEvents.push(setSplitEventId)

  tx.setSplitEvents = setSplitEvents;
  tx.save();
}

export function saveSplitRecipientAddedEvent(
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt,
  accountId: string,
): void {
  let setSplitEventId = createJointId([SET_SPLIT_EVENT_PREFIX, txHash, logIdx.toString()]);

  let recipientAddedEventId = createJointId([ADDED_PREFIX, setSplitEventId, accountId]);
  let recipientAddedEvent = new RecipientAddedEvent(recipientAddedEventId);
  recipientAddedEvent.timestamp = timestamp;
  recipientAddedEvent.account = accountId;
  recipientAddedEvent.setSplitEvent = setSplitEventId;
  recipientAddedEvent.save();
}

export function saveSplitRecipientRemovedEvent(
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt,
  accountId: string,
): void {
  let setSplitEventId = createJointId([SET_SPLIT_EVENT_PREFIX, txHash, logIdx.toString()]);

  let recipientRemovedEventId = createJointId([REMOVED_PREFIX, setSplitEventId, accountId]);
  let recipientRemovedEvent = new RecipientRemovedEvent(recipientRemovedEventId);
  recipientRemovedEvent.timestamp = timestamp;
  recipientRemovedEvent.account = accountId;
  recipientRemovedEvent.setSplitEvent = setSplitEventId;
  recipientRemovedEvent.save();
}

export function saveDistributeEvent(
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt,
  splitId: string,
  tokenId: string,
  amount: BigInt
): void {
  let tx = Transaction.load(txHash);
  if (!tx) tx = new Transaction(txHash);
  let distEvents = tx.distributionEvents;
  if (!distEvents) distEvents = new Array<string>();

  let distEventId = createJointId([DISTRIBUTION_EVENT_PREFIX, txHash, logIdx.toString()]);
  let distEvent = new DistributionEvent(distEventId);
  distEvent.timestamp = timestamp;
  distEvent.transaction = txHash;
  distEvent.logIndex = logIdx;
  distEvent.account = splitId;
  distEvent.amount = amount;
  distEvent.token = tokenId;
  distEvent.save();
  distEvents.push(distEventId);

  tx.distributionEvents = distEvents;
  tx.save();
}

export function distributeSplit(
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt,
  splitId: string,
  tokenId: string,
  amount: BigInt,
  distributorAddress: Address,
  blockNumber: i32
): void {
  let split = getSplit(splitId);
  if (!split) return;

  let token = new Token(tokenId);
  token.save();

  let distributionEventId = createJointId([
    DISTRIBUTION_EVENT_PREFIX,
    txHash,
    logIdx.toString()
  ]);

  let splitTokenBalanceId = createJointId([splitId, tokenId]);

  let splitTokenWithdrawalId = createJointId([
    TOKEN_WITHDRAWAL_SPLIT_PREFIX,
    splitTokenBalanceId
  ]);
  let splitTokenWithdrawal = TokenWithdrawal.load(splitTokenWithdrawalId);
  if (!splitTokenWithdrawal) {
    splitTokenWithdrawal = new TokenWithdrawal(splitTokenWithdrawalId);
    splitTokenWithdrawal.account = splitId;
    splitTokenWithdrawal.token = tokenId;
  }
  splitTokenWithdrawal.amount += amount;
  splitTokenWithdrawal.save();

  let splitTokenInternalBalanceId = createJointId([
    TOKEN_INTERNAL_BALANCE_PREFIX,
    splitTokenBalanceId
  ]);
  let splitTokenInternalBalance = TokenInternalBalance.load(
    splitTokenInternalBalanceId
  );
  if (splitTokenInternalBalance) {
    splitTokenInternalBalance.amount = ONE;
    splitTokenInternalBalance.save();
  }

  if (blockNumber > split.latestBlock) {
    split.latestBlock = blockNumber;
    split.save();
  }

  // doesn't know msg.sender; only affects advance users distributing from contracts
  // assuming they don't explicitly use distributorFee to repoint the proceeds elsewhere;
  // likely very rare & can fix accounting on withdrawal anyway)
  let distributorFee = split.distributorFee;
  if (distributorFee != ZERO) {
    let distributorAmount = (amount * distributorFee) / PERCENTAGE_SCALE;
    amount -= distributorAmount;

    // if address is zero, dont give to any account (don't know msg.sender)
    if (distributorAddress != Address.zero()) {
      let distributorAddressString = distributorAddress.toHexString();

      // 'Create' the user in case they don't exist yet
      let user = new User(distributorAddressString);
      user.save();

      addBalanceToUser(distributorAddressString, tokenId, distributorAmount);

      let distributeDistributionEventId = createJointId([
        DISTRIBUTE_PREFIX,
        distributionEventId,
        distributorAddressString
      ]);
      let distributeDistributionEvent = new DistributeDistributionEvent(
        distributeDistributionEventId
      );
      distributeDistributionEvent.timestamp = timestamp;
      distributeDistributionEvent.account = distributorAddressString;
      distributeDistributionEvent.token = tokenId;
      distributeDistributionEvent.amount = distributorAmount;
      distributeDistributionEvent.distributionEvent = distributionEventId;
      distributeDistributionEvent.save();
    }
  }

  let recipients = split.recipients;
  for (let i: i32 = 0; i < recipients.length; i++) {
    let recipientId = recipients[i];
    // must exist
    let recipient = Recipient.load(recipientId) as Recipient;
    let ownership = recipient.ownership;
    let recipientAmount = (amount * ownership) / PERCENTAGE_SCALE;
    addBalanceToUser(recipient.account, tokenId, recipientAmount);

    let receiveDistributionEventId = createJointId([
      RECEIVE_PREFIX,
      distributionEventId,
      recipient.account
    ]);
    let receiveDistributionEvent = new ReceiveDistributionEvent(
      receiveDistributionEventId
    );
    receiveDistributionEvent.timestamp = timestamp;
    receiveDistributionEvent.account = recipient.account;
    receiveDistributionEvent.token = tokenId;
    receiveDistributionEvent.amount = recipientAmount;
    receiveDistributionEvent.distributionEvent = distributionEventId;
    receiveDistributionEvent.save();
  }
}

export function saveWithdrawalEvent(
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt,
  accountId: string,
): string {
  let tx = Transaction.load(txHash);
  if (!tx) tx = new Transaction(txHash);
  tx.save();

  let withdrawalEventId = createJointId([
    WITHDRAWAL_EVENT_PREFIX,
    txHash,
    logIdx.toString(),
    accountId,
  ]);
  let withdrawalEvent = new WithdrawalEvent(withdrawalEventId);
  withdrawalEvent.timestamp = timestamp;
  withdrawalEvent.account = accountId;
  withdrawalEvent.transaction = txHash;
  withdrawalEvent.save();

  return withdrawalEventId
}

export function saveControlTransferEvents(
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt,
  splitId: string,
  type: string,
  fromUserId: string,
  toUserId: string,
): void {
  let tx = Transaction.load(txHash);
  if (!tx) tx = new Transaction(txHash);
  tx.save();

  let controlTransferEventId = createJointId([
    CONTROL_TRANSFER_EVENT_PREFIX,
    txHash,
    logIdx.toString()
  ]);
  let controlTransferEvent = new ControlTransferEvent(controlTransferEventId);
  controlTransferEvent.timestamp = timestamp;
  controlTransferEvent.account = splitId;
  controlTransferEvent.type = type;
  controlTransferEvent.transaction = txHash;
  controlTransferEvent.save();
  
  let fromUserControlTransferEventId = createJointId([
    FROM_USER_PREFIX,
    controlTransferEventId,
    fromUserId,
  ]);
  let fromUserControlTransferEvent = new FromUserControlTransferEvent(fromUserControlTransferEventId);
  fromUserControlTransferEvent.timestamp = timestamp;
  fromUserControlTransferEvent.account = fromUserId;
  fromUserControlTransferEvent.controlTransferEvent = controlTransferEventId;
  fromUserControlTransferEvent.save();
  
  if (toUserId != Address.zero().toHexString()) {
    let toUserControlTransferEventId = createJointId([
      TO_USER_PREFIX,
      controlTransferEventId,
      toUserId,
    ]);
    let toUserControlTransferEvent = new ToUserControlTransferEvent(toUserControlTransferEventId);
    toUserControlTransferEvent.timestamp = timestamp;
    toUserControlTransferEvent.account = toUserId;
    toUserControlTransferEvent.controlTransferEvent = controlTransferEventId;
    toUserControlTransferEvent.save();
  }
}

export function handleTokenWithdrawal(
  withdrawalEventId: string,
  accountId: string,
  tokenId: string,
  amount: BigInt,
  resetBalance: boolean
): void {
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

  let tokenInternalBalanceId = createJointId([
    TOKEN_INTERNAL_BALANCE_PREFIX,
    tokenBalanceId
  ]);
  let tokenInternalBalance = TokenInternalBalance.load(tokenInternalBalanceId);
  if (!tokenInternalBalance) {
    tokenInternalBalance = new TokenInternalBalance(tokenInternalBalanceId);
    tokenInternalBalance.account = accountId;
    tokenInternalBalance.token = tokenId;
  }

  // There's a bug on ethereum when distribute and withdraw events are grouped together in a transaction.
  // Subtracting the amount in that case instead of just setting the balance to one handles it (because
  // this is running before the distribute function in that case).
  // See: https://linear.app/0xsplits/issue/PANDE-354/fix-subgraph-bug
  if (resetBalance) {
    tokenInternalBalance.amount = ONE;
  } else {
    tokenInternalBalance.amount -= amount;
  }
  tokenInternalBalance.save();

  let tokenWithdrawalEventId = createJointId([
    TOKEN_PREFIX,
    withdrawalEventId,
    tokenId,
  ]);
  let tokenWithdrawalEvent = new TokenWithdrawalEvent(tokenWithdrawalEventId);
  tokenWithdrawalEvent.token = tokenId;
  tokenWithdrawalEvent.amount = amount;
  tokenWithdrawalEvent.withdrawalEvent = withdrawalEventId;
  tokenWithdrawalEvent.save();
}

export function createUserIfMissing(
  accountId: string,
): void {
  // only create a User if accountId doesn't point to another module
  let split = Split.load(accountId);
  if (split) return;

  let waterfall = WaterfallModule.load(accountId);
  if (waterfall) return;

  let vesting = VestingModule.load(accountId);
  if (vesting) return;

  let user = new User(accountId);
  user.save();
}

export function getSplit(splitId: string): Split | null {
  let split = Split.load(splitId);
  if (!split) {
    let splitUser = User.load(splitId);
    if (splitUser) return null; // It's a valid case where the split doesn't exist. Just exit.
    throw new Error('Split must exist');
  }

  return split;
}
