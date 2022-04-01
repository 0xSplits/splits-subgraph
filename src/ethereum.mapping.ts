import { store, BigInt, Address } from "@graphprotocol/graph-ts";
import {
  CancelControlTransfer,
  ControlTransfer,
  CreateSplit,
  CreateSplitCall,
  DistributeERC20,
  DistributeERC20Call,
  DistributeETH,
  DistributeETHCall,
  InitiateControlTransfer,
  UpdateSplit,
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
  DistributionEvent,
} from "../generated/schema";
import {
  createJointId,
  saveDistributeEvent,
  distributeSplit,
  handleTokenWithdrawal,
  saveCreateSplitEvent,
  saveUpdateSplitEvent,
  saveControlTransferEvents,
  saveWithdrawalEvent,
} from "./helpers";

export function handleCancelControlTransfer(
  event: CancelControlTransfer
): void {
  // must exist
  let split = Split.load(event.params.split.toHexString()) as Split;
  let oldPotentialController = split.newPotentialController;
  split.newPotentialController = Address.zero();
  split.save();

  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;

  saveControlTransferEvents(
    timestamp,
    txHash,
    logIdx,
    split.id,
    'cancel',
    split.controller.toHexString(),
    oldPotentialController.toHexString(),
  )
}

export function handleControlTransfer(event: ControlTransfer): void {
  // must exist
  let split = Split.load(event.params.split.toHexString()) as Split;
  let oldController = split.controller;
  split.controller = event.params.newController;
  split.newPotentialController = Address.zero();
  split.save();

  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;

  saveControlTransferEvents(
    timestamp,
    txHash,
    logIdx,
    split.id,
    'transfer',
    oldController.toHexString(),
    split.controller.toHexString(),
  )
}

export function handleCreateSplit(event: CreateSplit): void {
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;
  let splitId = event.params.split.toHexString();

  saveCreateSplitEvent(timestamp, txHash, logIdx, splitId);
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
  // TODO: explore cleaning this up w union type
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;
  let splitId = event.params.split.toHexString();
  let tokenId = event.params.token.toHexString();
  let amount = event.params.amount;
  saveDistributeEvent(timestamp, txHash, logIdx, splitId, tokenId, amount);
}

export function handleDistributeETH(event: DistributeETH): void {
  // TODO: explore cleaning this up w union type
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;
  let splitId = event.params.split.toHexString();
  let tokenId = Address.zero().toHexString();
  let amount = event.params.amount;
  saveDistributeEvent(timestamp, txHash, logIdx, splitId, tokenId, amount);
}

export function handleDistributeERC20Call(call: DistributeERC20Call): void {
  // TODO: explore cleaning this up w union type
  let timestamp = call.block.timestamp;
  let txHash = call.transaction.hash.toHexString();
  let splitId = call.inputs.split.toHexString();
  let tokenId = call.inputs.token.toHexString();
  let distributorAddress =
    call.inputs.distributorAddress != Address.zero()
      ? call.inputs.distributorAddress
      : call.from;

  let distributionEvent = _getDistributionEvent(
    txHash,
    splitId,
    tokenId
  ) as DistributionEvent;
  let amount = distributionEvent.amount;
  let logIdx = distributionEvent.logIndex;
  distributeSplit(
    timestamp,
    txHash,
    logIdx,
    splitId,
    tokenId,
    amount,
    distributorAddress
  );
}

export function handleDistributeETHCall(call: DistributeETHCall): void {
  // TODO: explore cleaning this up w union type
  let timestamp = call.block.timestamp;
  let txHash = call.transaction.hash.toHexString();
  let splitId = call.inputs.split.toHexString();
  let tokenId = Address.zero().toHexString();
  let distributorAddress =
    call.inputs.distributorAddress != Address.zero()
      ? call.inputs.distributorAddress
      : call.from;

  let distributionEvent = _getDistributionEvent(
    txHash,
    splitId,
    tokenId
  ) as DistributionEvent;
  let amount = distributionEvent.amount;
  let logIdx = distributionEvent.logIndex;
  distributeSplit(
    timestamp,
    txHash,
    logIdx,
    splitId,
    tokenId,
    amount,
    distributorAddress
  );
}

function _getDistributionEvent(
  txHash: string,
  splitId: string,
  tokenId: string
): DistributionEvent | null {
  // must exist (event handlers fire before call handlers)
  let tx = Transaction.load(txHash) as Transaction;
  // must exist (event handlers fire before call handlers)
  let distEvents = tx.distributionEvents as Array<string>;
  let distEvent: DistributionEvent;
  for (let i = 0; i < distEvents.length; i++) {
    let distEvent = DistributionEvent.load(distEvents[i]) as DistributionEvent;
    // take the earliest event that exists matching the split & token
    // note: if we want to support txns that distribute the same token for the
    // same split twice, will need to add some kind of 'processed' boolean to
    // event
    if (distEvent.account == splitId && distEvent.token == tokenId) {
      return distEvent;
    }
  }
  return null;
}

export function handleInitiateControlTransfer(
  event: InitiateControlTransfer
): void {
  // must exist
  let split = Split.load(event.params.split.toHexString()) as Split;
  split.newPotentialController = event.params.newPotentialController;
  split.save();

  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;

  saveControlTransferEvents(
    timestamp,
    txHash,
    logIdx,
    split.id,
    'initiate',
    split.controller.toHexString(),
    split.newPotentialController.toHexString(),
  )
}

export function handleUpdateSplit(event: UpdateSplit): void {
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;
  let splitId = event.params.split.toHexString();

  saveUpdateSplitEvent(timestamp, txHash, logIdx, splitId);
}

export function handleUpdateSplitCall(call: UpdateSplitCall): void {
  let splitId = call.inputs.split.toHexString();
  let accounts = call.inputs.accounts.map<string>(acc => acc.toHexString());
  let percentAllocations = call.inputs.percentAllocations;
  let distributorFee = call.inputs.distributorFee;
  _updateSplit(
    splitId,
    call.block.number.toI32(),
    accounts,
    percentAllocations,
    distributorFee
  );
}

export function handleUpdateAndDistributeETHCall(
  call: UpdateAndDistributeETHCall
): void {
  let timestamp = call.block.timestamp;
  let txHash = call.transaction.hash.toHexString();
  let splitId = call.inputs.split.toHexString();
  let tokenId = Address.zero().toHexString();
  let accounts = call.inputs.accounts.map<string>(acc => acc.toHexString());
  let percentAllocations = call.inputs.percentAllocations;
  let distributorFee = call.inputs.distributorFee;
  let distributorAddress =
    call.inputs.distributorAddress != Address.zero()
      ? call.inputs.distributorAddress
      : call.from;

  _updateSplit(
    splitId,
    call.block.number.toI32(),
    accounts,
    percentAllocations,
    distributorFee
  );

  let distributionEvent = _getDistributionEvent(
    txHash,
    splitId,
    tokenId
  ) as DistributionEvent;
  let amount = distributionEvent.amount;
  let logIdx = distributionEvent.logIndex;
  distributeSplit(
    timestamp,
    txHash,
    logIdx,
    splitId,
    tokenId,
    amount,
    distributorAddress
  );
}

export function handleUpdateAndDistributeERC20Call(
  call: UpdateAndDistributeERC20Call
): void {
  let timestamp = call.block.timestamp;
  let txHash = call.transaction.hash.toHexString();
  let splitId = call.inputs.split.toHexString();
  let tokenId = call.inputs.token.toHexString();
  let accounts = call.inputs.accounts.map<string>(acc => acc.toHexString());
  let percentAllocations = call.inputs.percentAllocations;
  let distributorFee = call.inputs.distributorFee;
  let distributorAddress =
    call.inputs.distributorAddress != Address.zero()
      ? call.inputs.distributorAddress
      : call.from;

  _updateSplit(
    splitId,
    call.block.number.toI32(),
    accounts,
    percentAllocations,
    distributorFee
  );

  let distributionEvent = _getDistributionEvent(
    txHash,
    splitId,
    tokenId
  ) as DistributionEvent;
  let amount = distributionEvent.amount;
  let logIdx = distributionEvent.logIndex;
  distributeSplit(
    timestamp,
    txHash,
    logIdx,
    splitId,
    tokenId,
    amount,
    distributorAddress
  );
}

export function handleWithdrawal(event: Withdrawal): void {
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;
  let account = event.params.account.toHexString();
  let ethAmount = event.params.ethAmount;
  let tokens = event.params.tokens;
  let tokenAmounts = event.params.tokenAmounts;

  let withdrawalEventId = saveWithdrawalEvent(
    timestamp,
    txHash,
    logIdx,
    account
  );

  if (ethAmount) {
    handleTokenWithdrawal(
      withdrawalEventId,
      account,
      Address.zero().toHexString(),
      ethAmount
    );
  }

  for (let i: i32 = 0; i < tokens.length; i++) {
    handleTokenWithdrawal(
      withdrawalEventId,
      account,
      tokens[i].toHexString(),
      tokenAmounts[i]
    );
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
