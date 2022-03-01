import { BigInt, Address, TypedMap, store } from "@graphprotocol/graph-ts";
import {
  SplitMain,
  CancelControlTransfer,
  ControlTransfer,
  CreateSplit,
  DistributeERC20,
  DistributeETH,
  InitiateControlTransfer,
  UpdateSplit,
  Withdrawal
} from "../generated/SplitMain/SplitMain";
import { SplitWallet } from "../generated/templates";
import { ReceiveETH } from "../generated/templates/SplitWallet/SplitWallet";
import {
  Split,
  User,
  Recipient,
  TokenInternalBalance,
  TokenWithdrawals
} from "../generated/schema";

// TODO: helper fns?

const PERCENTAGE_SCALE = BigInt.fromI64(1e6 as i64);
const ONE = BigInt.fromI32(1);

export function handleCancelControlTransfer(
  event: CancelControlTransfer
): void {
  // use new object for partial updates when existing values not needed
  let split = new Split(event.params.split.toString());
  split.newPotentialController = Address.zero();
  split.save();
}

export function handleControlTransfer(event: ControlTransfer): void {
  // use new object for partial updates when existing values not needed
  let split = new Split(event.params.split.toString());
  split.controller = event.params.newController;
  split.newPotentialController = Address.zero();
  split.save();
}

export function handleCreateSplit(event: CreateSplit): void {
  let splitId = event.params.split.toString();
  let split = new Split(splitId);
  split.controller = event.params.controller;
  split.distributorFee = event.params.distributorFee;
  split.save();

  let accounts = event.params.accounts;
  let percentAllocations = event.params.percentAllocations;
  for (let i: i32 = 0; i < accounts.length; i++) {
    let account = accounts[i].toString();
    let recipient = new Recipient(splitId + account);
    recipient.split = splitId;
    recipient.account = account;
    recipient.ownership = percentAllocations[i];
    recipient.save();
  }
}

export function handleDistributeERC20(event: DistributeERC20): void {
  let splitId = event.params.split.toString();
  let tokenId = event.params.token.toString();
  let amount = event.params.amount;
  let distributorAddress = event.params.distributorAddress;
  _handleDistribute(splitId, tokenId, amount, distributorAddress);
}

export function handleDistributeETH(event: DistributeETH): void {
  let splitId = event.params.split.toString();
  let tokenId = Address.zero().toString();
  let amount = event.params.amount;
  let distributorAddress = event.params.distributorAddress;
  _handleDistribute(splitId, tokenId, amount, distributorAddress);
}

function _handleDistribute(
  splitId: string,
  tokenId: string,
  amount: BigInt,
  distributorAddress: Address
): void {
  let splitTokenBalanceId = splitId + tokenId;
  let splitTokenInternalBalance = TokenInternalBalance.load(
    splitTokenBalanceId
  );
  if (splitTokenInternalBalance) {
    splitTokenInternalBalance.amount = ONE;
    splitTokenInternalBalance.save();
  }

  // must exist
  let split = Split.load(splitId) as Split;

  // doesn't know msg.sender; only affects advance users distributing from contracts
  // assuming they don't explicitly use distributorFee to repoint the proceeds elsewhere;
  // likely very rare & can fix accounting on withdrawal anyway)
  let distributorFee = split.distributorFee;
  if (distributorFee !== BigInt.zero()) {
    let distributorAmount = (amount * distributorFee) / PERCENTAGE_SCALE;
    amount -= distributorAmount;

    // if address is zero, dont give to any account (don't know msg.sender)
    if (distributorAddress !== Address.zero()) {
      let distributorTokenBalanceId = distributorAddress.toString() + tokenId;
      let distributorTokenInternalBalance = TokenInternalBalance.load(
        distributorTokenBalanceId
      );
      if (!distributorTokenInternalBalance)
        distributorTokenInternalBalance = new TokenInternalBalance(
          distributorTokenBalanceId
        );
      distributorTokenInternalBalance.amount += distributorAmount;
      distributorTokenInternalBalance.save();
    }
  }

  let recipients = split.recipients;
  for (let i: i32 = 0; i < recipients.length; i++) {
    let recipientId = splitId + recipients[i];
    // must exist
    let recipient = Recipient.load(recipientId) as Recipient;
    let ownership = recipient.ownership;
    let recipientAmount = (amount * ownership) / PERCENTAGE_SCALE;

    let recipientTokenBalanceId = recipients[i] + tokenId;
    let recipientTokenInternalBalance = TokenInternalBalance.load(
      recipientTokenBalanceId
    );
    if (!recipientTokenInternalBalance)
      recipientTokenInternalBalance = new TokenInternalBalance(
        recipientTokenBalanceId
      );
    recipientTokenInternalBalance.amount += recipientAmount;
    recipientTokenInternalBalance.save();
  }
}

export function handleInitiateControlTransfer(
  event: InitiateControlTransfer
): void {
  // use new object for partial updates when existing values not needed
  let split = new Split(event.params.split.toString());
  split.newPotentialController = event.params.newPotentialController;
  split.save();
}

export function handleUpdateSplit(event: UpdateSplit): void {
  // use new object for partial updates when existing values not needed
  let splitId = event.params.split.toString();
  // must exist
  let split = Split.load(splitId) as Split;
  split.distributorFee = event.params.distributorFee;
  split.save();

  let accounts = event.params.accounts;
  let accountSet = new Set<string>();
  for (let i: i32 = 0; i < accounts.length; i++) {
    let account = accounts[i].toString();
    accountSet.add(account);
    let recipient = new Recipient(splitId + account);
    recipient.account = account;
    recipient.split = splitId;
    recipient.ownership = event.params.percentAllocations[i];
    recipient.save();
  }

  // delete existing recipients not in updated split
  let recipients = split.recipients;
  for (let i: i32 = 0; i < recipients.length; i++) {
    let recipient = recipients[i];
    // remove recipients no longer in split
    if (!accountSet.has(recipient)) store.remove("Recipient", recipient);
  }
}

export function handleWithdrawal(event: Withdrawal): void {
  let account = event.params.account;
  let ethAmount = event.params.ethAmount;
  let tokens = event.params.tokens;
  let tokenAmounts = event.params.tokenAmounts;

  if (ethAmount) {
    let tokenBalanceId = account.toString() + Address.zero().toString();

    let tokenWithdrawals = TokenWithdrawals.load(tokenBalanceId);
    if (!tokenWithdrawals)
      tokenWithdrawals = new TokenWithdrawals(tokenBalanceId);
    tokenWithdrawals.amount += ethAmount;
    tokenWithdrawals.save();

    let tokenInternalBalance = new TokenInternalBalance(tokenBalanceId);
    tokenInternalBalance.amount = ONE;
    tokenInternalBalance.save();
  }

  for (let i: i32 = 0; i < tokens.length; i++) {
    let tokenBalanceId = account.toString() + tokens[i].toString();
    let tokenAmount = tokenAmounts[i];

    let tokenWithdrawals = TokenWithdrawals.load(tokenBalanceId);
    if (!tokenWithdrawals)
      tokenWithdrawals = new TokenWithdrawals(tokenBalanceId);
    tokenWithdrawals.amount += tokenAmount;
    tokenWithdrawals.save();

    let tokenInternalBalance = new TokenInternalBalance(tokenBalanceId);
    tokenInternalBalance.amount = ONE;
    tokenInternalBalance.save();
  }
}
