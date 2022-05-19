import { store, Address } from "@graphprotocol/graph-ts";
import {
  CancelControlTransfer,
  ControlTransfer,
  CreateSplit,
  DistributeERC20,
  DistributeETH,
  InitiateControlTransfer,
  UpdateSplit,
  Withdrawal
} from "../generated/SplitMain/SplitMain";
import { Split, Recipient, User } from "../generated/schema";
import {
  createJointId,
  saveWithdrawalEvent,
  saveDistributeEvent,
  distributeSplit,
  handleTokenWithdrawal,
  saveControlTransferEvents,
  saveSetSplitEvent,
  saveSplitRecipientAddedEvent,
  saveSplitRecipientRemovedEvent,
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
  );
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
  );
}

export function handleCreateSplit(event: CreateSplit): void {
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;
  let splitId = event.params.split.toHexString();

  saveSetSplitEvent(timestamp, txHash, logIdx, splitId, 'create');

  // check & remove if a user exists at splitId
  let splitUserId = User.load(splitId);
  if (splitUserId) store.remove("User", splitId);

  let split = new Split(splitId);
  split.latestBlock = event.block.number.toI32();
  split.controller = event.params.controller;
  split.newPotentialController = Address.zero();
  split.distributorFee = event.params.distributorFee;

  let accounts = event.params.accounts;
  let percentAllocations = event.params.percentAllocations;
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

    saveSplitRecipientAddedEvent(
      timestamp,
      txHash,
      logIdx,
      accountId
    )
  }

  split.recipients = recipientIds;
  split.save();
}

export function handleDistributeERC20(event: DistributeERC20): void {
  // TODO: explore cleaning this up w union type
  let timestamp = event.block.timestamp;
  let blockNumber = event.block.number.toI32();
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;
  let splitId = event.params.split.toHexString();
  let tokenId = event.params.token.toHexString();
  let amount = event.params.amount;
  let distributorAddress = event.params.distributorAddress;
  saveDistributeEvent(timestamp, txHash, logIdx, splitId, tokenId, amount);
  distributeSplit(
    timestamp,
    txHash,
    logIdx,
    splitId,
    tokenId,
    amount,
    distributorAddress,
    blockNumber
  );
}

export function handleDistributeETH(event: DistributeETH): void {
  // TODO: explore cleaning this up w union type
  let timestamp = event.block.timestamp;
  let blockNumber = event.block.number.toI32();
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;
  let splitId = event.params.split.toHexString();
  let tokenId = Address.zero().toHexString();
  let amount = event.params.amount;
  let distributorAddress = event.params.distributorAddress;
  saveDistributeEvent(timestamp, txHash, logIdx, splitId, tokenId, amount);
  distributeSplit(
    timestamp,
    txHash,
    logIdx,
    splitId,
    tokenId,
    amount,
    distributorAddress,
    blockNumber
  );
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
  );
}

export function handleUpdateSplit(event: UpdateSplit): void {
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;
  let splitId = event.params.split.toHexString();

  saveSetSplitEvent(timestamp, txHash, logIdx, splitId, 'update');

  // use new object for partial updates when existing values not needed
  // must exist
  let split = Split.load(splitId) as Split;
  split.latestBlock = event.block.number.toI32();
  split.distributorFee = event.params.distributorFee;
  let oldRecipientIds = split.recipients;
  let newRecipientIds = new Array<string>();
  let newRecipientIdSet = new Set<string>();

  let accounts = event.params.accounts;
  let percentAllocations = event.params.percentAllocations;
  for (let i: i32 = 0; i < accounts.length; i++) {
    let accountId = accounts[i].toHexString();
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

    if (!oldRecipientIds.includes(recipientId)) {
      saveSplitRecipientAddedEvent(
        timestamp,
        txHash,
        logIdx,
        accountId
      );
    }
  }

  // delete existing recipients not in updated split
  for (let i: i32 = 0; i < oldRecipientIds.length; i++) {
    let recipientId = oldRecipientIds[i];
    // remove recipients no longer in split
    if (!newRecipientIdSet.has(recipientId)) {
      let removedRecipient = Recipient.load(recipientId);
      if (removedRecipient)
        saveSplitRecipientRemovedEvent(
          timestamp,
          txHash,
          logIdx,
          removedRecipient.account
        );
      store.remove("Recipient", recipientId);
    }
  }

  split.recipients = newRecipientIds;
  split.save();
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
      ethAmount,
      true
    );
  }

  for (let i: i32 = 0; i < tokens.length; i++) {
    handleTokenWithdrawal(
      withdrawalEventId,
      account,
      tokens[i].toHexString(),
      tokenAmounts[i],
      true
    );
  }
}
