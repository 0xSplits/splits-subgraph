import { store, BigInt, Address } from "@graphprotocol/graph-ts";
import {
  SplitMain,
  CancelControlTransfer,
  ControlTransfer,
  CreateSplitCall,
  DistributeERC20,
  DistributeERC20Call,
  DistributeETH,
  DistributeETHCall,
  InitiateControlTransfer,
  UpdateSplitCall,
  UpdateAndDistributeETHCall,
  UpdateAndDistributeERC20Call,
  Withdrawal
} from "../generated/SplitMain/SplitMain";
import {
  Split,
  Recipient,
  User,
  Transaction,
  DistributionEvent
} from "../generated/schema";
import {
  createJointId,
  distributeSplit,
  handleTokenWithdrawal,
  PERCENTAGE_SCALE,
  ZERO,
  ONE,
  TOKEN_WITHDRAWAL_PREFIX,
  TOKEN_INTERNAL_BALANCE_PREFIX,
  ID_SEPARATOR
} from "./helpers";

const MAX_BIGINT = BigInt.fromI32(i32.MAX_VALUE);

export function handleCancelControlTransfer(
  event: CancelControlTransfer
): void {
  // must exist
  let split = Split.load(event.params.split.toHexString()) as Split;
  split.newPotentialController = Address.zero();
  split.save();
}

export function handleControlTransfer(event: ControlTransfer): void {
  // must exist
  let split = Split.load(event.params.split.toHexString()) as Split;
  split.controller = event.params.newController;
  split.newPotentialController = Address.zero();
  split.save();
}

export function handleCreateSplitCall(call: CreateSplitCall): void {
  let splitId = call.outputs.split.toHexString();
  // check & remove if a user exists at splitId
  let splitUserId = User.load(splitId);
  if (splitUserId) store.remove("User", splitId);

  let split = new Split(splitId);
  split.latestBlock = call.block.number.toI32();
  split.controller = call.inputs.controller;
  split.newPotentialController = Address.zero();
  split.distributorFee = call.inputs.distributorFee;

  let accounts = call.inputs.accounts;
  let percentAllocations = call.inputs.percentAllocations;
  let recipientIds = new Array<string>();

  for (let i: i32 = 0; i < accounts.length; i++) {
    let accountId = accounts[i].toHexString();
    // only create a User if accountId doesn't point to a Split
    let splitAccountId = Split.load(accountId);
    if (!splitAccountId) {
      let user = new User(accountId);
      user.save();
    }

    let recipientId = createJointId([splitId, accountId]);
    let recipient = new Recipient(recipientId);
    recipient.split = splitId;
    recipient.account = accountId;
    recipient.ownership = percentAllocations[i];
    recipient.save();
    recipientIds.push(recipientId);
  }

  split.recipients = recipientIds;
  split.save();
}

export function handleDistributeERC20(event: DistributeERC20): void {
  let splitId = event.params.split.toHexString();
  let tokenId = event.params.token.toHexString();
  let amount = event.params.amount;
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;
  _handleDistributeEvent(splitId, tokenId, amount, txHash, logIdx);
}

export function handleDistributeETH(event: DistributeETH): void {
  let splitId = event.params.split.toHexString();
  let tokenId = Address.zero().toHexString();
  let amount = event.params.amount;
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;
  _handleDistributeEvent(splitId, tokenId, amount, txHash, logIdx);
}

function _handleDistributeEvent(
  splitId: string,
  tokenId: string,
  amount: BigInt,
  txHash: string,
  logIdx: BigInt
): void {
  let tx = Transaction.load(txHash);
  if (!tx) tx = new Transaction(txHash);
  let distEvents = tx.distributionEvents;
  if (!distEvents) distEvents = new Array<string>();

  let distEventId = createJointId([txHash, logIdx.toString()]);
  let distEvent = new DistributionEvent(distEventId);
  distEvent.transaction = txHash;
  distEvent.logIndex = logIdx;
  distEvent.split = splitId;
  distEvent.amount = amount;
  distEvent.token = tokenId;
  distEvent.save();
  distEvents.push(distEventId);

  tx.distributionEvents = distEvents;
  tx.save();
}

export function handleDistributeERC20Call(call: DistributeERC20Call): void {
  let splitId = call.inputs.split.toHexString();
  let tokenId = call.inputs.token.toHexString();
  let distributorAddress =
    call.inputs.distributorAddress != Address.zero()
      ? call.inputs.distributorAddress
      : call.from;
  let txHash = call.transaction.hash.toHexString();

  let amount = _getDistributionAmount(splitId, tokenId, txHash);
  distributeSplit(splitId, tokenId, amount, distributorAddress);
}

export function handleDistributeETHCall(call: DistributeETHCall): void {
  let splitId = call.inputs.split.toHexString();
  let tokenId = Address.zero().toHexString();
  let distributorAddress =
    call.inputs.distributorAddress != Address.zero()
      ? call.inputs.distributorAddress
      : call.from;
  let txHash = call.transaction.hash.toHexString();

  let amount = _getDistributionAmount(splitId, tokenId, txHash);
  distributeSplit(splitId, tokenId, amount, distributorAddress);
}

function _getDistributionAmount(
  splitId: string,
  tokenId: string,
  txHash: string
): BigInt {
  // must exist (event handlers fire before call handlers)
  let tx = Transaction.load(txHash) as Transaction;
  // must exist (event handlers fire before call handlers)
  let distEvents = tx.distributionEvents as Array<string>;
  let amount = ZERO;
  let logIdx = MAX_BIGINT;
  for (let i = 0; i < distEvents.length; i++) {
    let distEvent = DistributionEvent.load(distEvents[i]) as DistributionEvent;
    // take the earliest event that exists matching the split & token
    if (
      distEvent.split == splitId &&
      distEvent.token == tokenId &&
      distEvent.logIndex < logIdx
    ) {
      amount = distEvent.amount;
      logIdx = distEvent.logIndex;
    }
  }
  // remove the used distribution event & tx if that was the last attached event
  store.remove("DistributionEvent", createJointId([tx.id, logIdx.toString()]));
  if (distEvents.length <= 1) store.remove("Transaction", tx.id);

  return amount;
}

export function handleInitiateControlTransfer(
  event: InitiateControlTransfer
): void {
  // must exist
  let split = Split.load(event.params.split.toHexString()) as Split;
  split.newPotentialController = event.params.newPotentialController;
  split.save();
}

export function handleUpdateSplitCall(call: UpdateSplitCall): void {
  let splitId = call.inputs.split.toHexString();
  let accounts = call.inputs.accounts.map<string>(acc => acc.toHexString());
  let percentAllocations = call.inputs.percentAllocations;
  let distributorFee = call.inputs.distributorFee;
  _updateSplit(splitId, call.block.number.toI32(), accounts, percentAllocations, distributorFee);
}

export function handleUpdateAndDistributeETHCall(
  call: UpdateAndDistributeETHCall
): void {
  let splitId = call.inputs.split.toHexString();
  let tokenId = Address.zero().toHexString();
  let accounts = call.inputs.accounts.map<string>(acc => acc.toHexString());
  let percentAllocations = call.inputs.percentAllocations;
  let distributorFee = call.inputs.distributorFee;
  let distributorAddress =
    call.inputs.distributorAddress != Address.zero()
      ? call.inputs.distributorAddress
      : call.from;
  let txHash = call.transaction.hash.toHexString();

  _updateSplit(splitId, call.block.number.toI32(), accounts, percentAllocations, distributorFee);

  let amount = _getDistributionAmount(splitId, tokenId, txHash);
  distributeSplit(splitId, tokenId, amount, distributorAddress);
}

export function handleUpdateAndDistributeERC20Call(
  call: UpdateAndDistributeERC20Call
): void {
  let splitId = call.inputs.split.toHexString();
  let tokenId = call.inputs.token.toHexString();
  let accounts = call.inputs.accounts.map<string>(acc => acc.toHexString());
  let percentAllocations = call.inputs.percentAllocations;
  let distributorFee = call.inputs.distributorFee;
  let distributorAddress =
    call.inputs.distributorAddress != Address.zero()
      ? call.inputs.distributorAddress
      : call.from;
  let txHash = call.transaction.hash.toHexString();

  _updateSplit(splitId, call.block.number.toI32(), accounts, percentAllocations, distributorFee);

  let amount = _getDistributionAmount(splitId, tokenId, txHash);
  distributeSplit(splitId, tokenId, amount, distributorAddress);
}

export function handleWithdrawal(event: Withdrawal): void {
  let account = event.params.account.toHexString();
  let ethAmount = event.params.ethAmount;
  let tokens = event.params.tokens;
  let tokenAmounts = event.params.tokenAmounts;

  if (ethAmount) {
    handleTokenWithdrawal(account, Address.zero().toHexString(), ethAmount);
  }

  for (let i: i32 = 0; i < tokens.length; i++) {
    handleTokenWithdrawal(account, tokens[i].toHexString(), tokenAmounts[i]);
  }
}

function _updateSplit(
  splitId: string,
  blockNumber: i32,
  accounts: string[],
  percentAllocations: BigInt[],
  distributorFee: BigInt
): void {
  // use new object for partial updates when existing values not needed
  // must exist
  let split = Split.load(splitId) as Split;
  split.latestBlock = blockNumber;
  split.distributorFee = distributorFee;
  let oldRecipientIds = split.recipients;
  let newRecipientIds = new Array<string>();

  let newRecipientIdSet = new Set<string>();
  for (let i: i32 = 0; i < accounts.length; i++) {
    let accountId = accounts[i];
    // only create a User if accountId doesn't point to a Split
    let splitAccountId = Split.load(accountId);
    if (!splitAccountId) {
      let user = new User(accountId);
      user.save();
    }

    let recipientId = createJointId([splitId, accountId]);
    newRecipientIdSet.add(recipientId);
    let recipient = new Recipient(recipientId);
    recipient.account = accountId;
    recipient.split = splitId;
    recipient.ownership = percentAllocations[i];
    recipient.save();
    newRecipientIds.push(recipientId);
  }

  // delete existing recipients not in updated split
  for (let i: i32 = 0; i < oldRecipientIds.length; i++) {
    let recipientId = oldRecipientIds[i];
    // remove recipients no longer in split
    if (!newRecipientIdSet.has(recipientId))
      store.remove("Recipient", recipientId);
  }

  split.recipients = newRecipientIds;
  split.save();
}
