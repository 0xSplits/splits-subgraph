import { Address, store, log } from "@graphprotocol/graph-ts";
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
  createUserIfMissing,
  saveWithdrawalEvent,
  saveDistributeEvent,
  distributeSplit,
  handleTokenWithdrawal,
  saveControlTransferEvents,
  saveSetSplitEvent,
  saveSplitRecipientAddedEvent,
  saveSplitRecipientRemovedEvent,
  getSplit,
  getAccountIdForSplitEvents,
  PERCENTAGE_SCALE,
  ZERO_ADDRESS,
  TWO,
  ONE_ADDRESS,
} from "./helpers";

export function handleCancelControlTransfer(
  event: CancelControlTransfer
): void {
  let splitId = event.params.split.toHexString();
  let split = getSplit(splitId);
  if (!split) return;

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
  let splitId = event.params.split.toHexString();
  let split = getSplit(splitId);
  if (!split) return;

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
  let blockNumber = event.block.number.toI32();
  let accounts = event.params.accounts;
  let percentAllocations = event.params.percentAllocations;

  // If a user already exists at this id, just return for now. Cannot have two
  // entities with the same id if they share an interface. Will handle this situation
  // in subgraph v2.
  let splitUser = User.load(splitId);
  if (splitUser) {
    log.warning('Trying to create a split, but a user already exists: {}', [splitId]);
    return;
  }

  saveSetSplitEvent(timestamp, txHash, logIdx, splitId, 'create');

  // Create controller as user EXCEPT when it looks like this is a payout split
  // for a liquid split. In this case don't create the user so we don't tie up
  // the address. This isn't needed in the ethereum call handler since that runs after
  // the liquid split event handler. It also only impacts custom liquid splits, not
  // factory liquid splits due to the ordering of events being different for the
  // two.
  let looksLikeLiquidSplitPayout = (
    accounts.length == 2 &&
    accounts[0].toHexString() == ZERO_ADDRESS &&
    accounts[1].toHexString() == ONE_ADDRESS &&
    percentAllocations[0] == PERCENTAGE_SCALE / TWO &&
    percentAllocations[1] == PERCENTAGE_SCALE / TWO
  )
  if (!looksLikeLiquidSplitPayout) {
    createUserIfMissing(event.params.controller.toHexString(), blockNumber, timestamp);
  }

  let split = new Split(splitId);
  split.createdBlock = blockNumber;
  split.latestBlock = blockNumber;
  split.latestActivity = timestamp;
  split.controller = event.params.controller;
  split.newPotentialController = Address.zero();
  split.distributorFee = event.params.distributorFee;

  let recipientIds = new Array<string>();
  for (let i: i32 = 0; i < accounts.length; i++) {
    let accountId = accounts[i].toHexString();
    createUserIfMissing(accountId, blockNumber, timestamp);

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
  let splitId = event.params.split.toHexString();
  let split = getSplit(splitId);
  if (!split) return;

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;

  createUserIfMissing(event.params.newPotentialController.toHexString(), blockNumber, timestamp);

  split.newPotentialController = event.params.newPotentialController;
  split.save();

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
  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;
  let splitId = event.params.split.toHexString();

  saveSetSplitEvent(timestamp, txHash, logIdx, splitId, 'update');

  // use new object for partial updates when existing values not needed
  let split = getSplit(splitId);
  if (!split) return;

  let eventsAccountId = getAccountIdForSplitEvents(splitId);
  let shouldSaveRecipientEvents = eventsAccountId == splitId;

  split.latestBlock = event.block.number.toI32();
  split.latestActivity = event.block.timestamp;
  split.distributorFee = event.params.distributorFee;
  let oldRecipientIds = split.recipients;
  let newRecipientIds = new Array<string>();
  let newRecipientIdSet = new Set<string>();

  let accounts = event.params.accounts;
  let percentAllocations = event.params.percentAllocations;
  for (let i: i32 = 0; i < accounts.length; i++) {
    let accountId = accounts[i].toHexString();
    createUserIfMissing(accountId, blockNumber, timestamp);

    let recipientId = createJointId([splitId, accountId]);
    newRecipientIdSet.add(recipientId);
    let recipient = new Recipient(recipientId);
    recipient.account = accountId;
    recipient.split = splitId;
    recipient.ownership = percentAllocations[i];
    recipient.save();
    newRecipientIds.push(recipientId);

    if (shouldSaveRecipientEvents && !oldRecipientIds.includes(recipientId)) {
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
      if (shouldSaveRecipientEvents && removedRecipient)
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
  let blockNumber = event.block.number.toI32();
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
      true,
      blockNumber,
      timestamp
    );
  }

  for (let i: i32 = 0; i < tokens.length; i++) {
    handleTokenWithdrawal(
      withdrawalEventId,
      account,
      tokens[i].toHexString(),
      tokenAmounts[i],
      true,
      blockNumber,
      timestamp
    );
  }
}
