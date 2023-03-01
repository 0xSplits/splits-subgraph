import { store, BigInt, Address, log } from "@graphprotocol/graph-ts";
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
  LiquidSplit,
  Recipient,
  User,
  Transaction,
  DistributionEvent,
  SetSplitEvent,
} from "../generated/schema";
import {
  createJointId,
  createUserIfMissing,
  saveDistributeEvent,
  distributeSplit,
  handleTokenWithdrawal,
  saveSetSplitEvent,
  saveSplitRecipientAddedEvent,
  saveSplitRecipientRemovedEvent,
  saveControlTransferEvents,
  saveWithdrawalEvent,
  getSplit,
  getAccountIdForSplitEvents,
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

  // If a user already exists at this id, just return for now. Cannot have two
  // entities with the same id if they share an interface. Will handle this situation
  // in subgraph v2.
  let splitUser = User.load(splitId);
  if (splitUser) return;

  saveSetSplitEvent(timestamp, txHash, logIdx, splitId, 'create');

  // Create dummy split so that the id doesn't get taken up by a user entity
  // before the call handler can create it
  let split = new Split(splitId);
  split.save();
}

export function handleCreateSplitCall(call: CreateSplitCall): void {
  let splitId = call.outputs.split.toHexString();
  let blockNumber = call.block.number.toI32();
  let timestamp = call.block.timestamp;
  
  // If a user already exists at this id, just return for now. Cannot have two
  // entities with the same id if they share an interface. Will handle this situation
  // in subgraph v2.
  let splitUser = User.load(splitId);
  if (splitUser) {
    log.warning('Trying to create a split, but a user already exists: {}', [splitId]);
    return;
  }

  let controllerId = call.inputs.controller.toHexString();
  createUserIfMissing(controllerId, blockNumber, timestamp);

  // Split must exist at this point, was created in event handler and we know it's not
  // a user entity
  let split = getSplit(splitId) as Split;
  split.createdBlock = blockNumber;
  split.latestBlock = blockNumber;
  split.latestActivity = timestamp;
  split.controller = call.inputs.controller;
  split.newPotentialController = Address.zero();
  split.distributorFee = call.inputs.distributorFee;

  let accounts = call.inputs.accounts;
  let percentAllocations = call.inputs.percentAllocations;
  let recipientIds = new Array<string>();

  let txHash = call.transaction.hash.toHexString();

  let setSplitEvent = _getSetSplitEvent(
    txHash,
    splitId,
  ) as SetSplitEvent;
  let logIdx = setSplitEvent.logIndex;

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

  let liquidSplitController = LiquidSplit.load(controllerId);
  if (liquidSplitController) {
    split.parentEntityType = 'liquidSplit';
  }

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
  let blockNumber = call.block.number.toI32();
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
    distributorAddress,
    blockNumber,
  );
}

export function handleDistributeETHCall(call: DistributeETHCall): void {
  // TODO: explore cleaning this up w union type
  let timestamp = call.block.timestamp;
  let blockNumber = call.block.number.toI32();
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
    distributorAddress,
    blockNumber
  );
}

function _getDistributionEvent(
  txHash: string,
  splitId: string,
  tokenId: string
): DistributionEvent | null {
  let accountId = getAccountIdForSplitEvents(splitId);
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
    if (distEvent.account == accountId && distEvent.token == tokenId) {
      return distEvent;
    }
  }
  return null;
}

function _getSetSplitEvent(
  txHash: string,
  splitId: string
): SetSplitEvent | null {
  // must exist (event handlers fire before call handlers)
  let tx = Transaction.load(txHash) as Transaction;
  // must exist (event handlers fire before call handlers)
  let setSplitEvents = tx.setSplitEvents as Array<string>;

  for (let i = 0; i < setSplitEvents.length; i++) {
    let setEvent = SetSplitEvent.load(setSplitEvents[i]) as SetSplitEvent;
    // take the earliest event that exists matching the split
    // note: if we want to support txns that set the same split twice,
    // will need to add some kind of 'processed' boolean to
    // event
    if (setEvent.account == splitId) {
      return setEvent;
    }
  }
  return null;
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
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  let logIdx = event.logIndex;
  let splitId = event.params.split.toHexString();

  saveSetSplitEvent(timestamp, txHash, logIdx, splitId, 'update');
}

export function handleUpdateSplitCall(call: UpdateSplitCall): void {
  let txHash = call.transaction.hash.toHexString();
  let timestamp = call.block.timestamp;
  let splitId = call.inputs.split.toHexString();
  let accounts = call.inputs.accounts.map<string>(acc => acc.toHexString());
  let percentAllocations = call.inputs.percentAllocations;
  let distributorFee = call.inputs.distributorFee;
  _updateSplit(
    txHash,
    timestamp,
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
  let blockNumber = call.block.number.toI32();
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
    txHash,
    timestamp,
    splitId,
    blockNumber,
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
    distributorAddress,
    blockNumber
  );
}

export function handleUpdateAndDistributeERC20Call(
  call: UpdateAndDistributeERC20Call
): void {
  let timestamp = call.block.timestamp;
  let blockNumber = call.block.number.toI32();
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
    txHash,
    timestamp,
    splitId,
    blockNumber,
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
    distributorAddress,
    blockNumber
  );
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
      false,
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
      false,
      blockNumber,
      timestamp
    );
  }
}

function _updateSplit(
  txHash: string,
  timestamp: BigInt,
  splitId: string,
  blockNumber: i32,
  accounts: string[],
  percentAllocations: BigInt[],
  distributorFee: BigInt
): void {
  // use new object for partial updates when existing values not needed
  let split = getSplit(splitId);
  if (!split) return;

  split.latestBlock = blockNumber;
  split.latestActivity = timestamp;
  split.distributorFee = distributorFee;
  let oldRecipientIds = split.recipients;
  let newRecipientIds = new Array<string>();

  let setSplitEvent = _getSetSplitEvent(
    txHash,
    splitId,
  ) as SetSplitEvent;
  let logIdx = setSplitEvent.logIndex;

  let eventsAccountId = getAccountIdForSplitEvents(splitId);
  let shouldSaveRecipientEvents = eventsAccountId == splitId;

  let newRecipientIdSet = new Set<string>();
  for (let i: i32 = 0; i < accounts.length; i++) {
    let accountId = accounts[i];
    // only create a User if accountId doesn't point to a Split
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
