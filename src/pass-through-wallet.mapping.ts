import { BigInt, log } from "@graphprotocol/graph-ts";
import { CreatePassThroughWallet } from "../generated/PassThroughWalletFactory/PassThroughWalletFactory";
import {
  ExecCalls,
  OwnershipTransferred,
  PassThrough,
  SetPassThrough,
  SetPaused,
} from "../generated/templates/PassThroughWallet/PassThroughWallet";
import { PassThroughWallet as PassThroughWalletTemplate } from "../generated/templates";
import {
  Token,
  User,
  PassThroughWallet,
  TokenRelease,
  Recipient,
  Swapper,
} from "../generated/schema";
import {
  createJointId,
  createTransactionIfMissing,
  createUserIfMissing,
  getPassThroughWallet,
  getSplit,
  TOKEN_RELEASE_PREFIX,
  ZERO,
  ZERO_ADDRESS,
} from "./helpers";

const CREATE_PASS_THROUGH_WALLET_EVENT_PREFIX = "cptwe";
const DIVERSIFIER_FACTORY_ADDRESS = "0xFE7800f67b3e42ddb004057169603FEAdEeD31B0";

export function handleCreatePassThroughWallet(event: CreatePassThroughWallet): void {
  let passThroughWalletId = event.params.passThroughWallet.toHexString();

  // If a user already exists at this id, just return for now. Cannot have two
  // entities with the same id if they share an interface. Will handle this situation
  // in subgraph v2.
  let passThroughWalletUser = User.load(passThroughWalletId);
  if (passThroughWalletUser) {
    log.warning('Trying to create a pass through wallet, but a user already exists: {}', [passThroughWalletId]);
    return;
  }

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  createTransactionIfMissing(txHash);
  let logIdx = event.logIndex;

  let passThroughWallet = new PassThroughWallet(passThroughWalletId);

  let owner = event.params.params[0].toAddress().toHexString();
  let paused = event.params.params[1].toBoolean();
  let passThroughAccount = event.params.params[2].toAddress().toHexString();

  createUserIfMissing(owner, blockNumber, timestamp);
  createUserIfMissing(passThroughAccount, blockNumber, timestamp);

  passThroughWallet.owner = owner;
  passThroughWallet.paused = paused;
  passThroughWallet.passThroughAccount = passThroughAccount;
  passThroughWallet.createdBlock = blockNumber;
  passThroughWallet.latestBlock = blockNumber;
  passThroughWallet.latestActivity = timestamp;

  passThroughWallet.save();
  PassThroughWalletTemplate.create(event.params.passThroughWallet);

  // Save event
  // let createPassThroughWalletEventId = createJointId([CREATE_PASS_THROUGH_WALLET_EVENT_PREFIX, txHash, logIdx.toString()]);
  // let createPassThroughWalletEvent = new CreatePassThroughWalletEvent(createPassThroughWalletEventId);
  // createPassThroughWalletEvent.timestamp = timestamp;
  // createPassThroughWalletEvent.transaction = txHash;
  // createPassThroughWalletEvent.logIndex = logIdx;
  // createPassThroughWalletEvent.account = passThroughWalletId;
  // createPassThroughWalletEvent.save();
}

export function handleSetPassThrough(event: SetPassThrough): void {
  let passThroughWalletId = event.address.toHexString();

  let passThroughWallet = getPassThroughWallet(passThroughWalletId);
  if (!passThroughWallet) return;

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;
  // let txHash = event.transaction.hash.toHexString();
  // createTransactionIfMissing(txHash);
  // let logIdx = event.logIndex;

  if (event.block.number.toI32() > passThroughWallet.latestBlock) {
    passThroughWallet.latestBlock = event.block.number.toI32();
    passThroughWallet.latestActivity = event.block.timestamp;
  }

  let newPassThrough = event.params.passThrough.toHexString();
  createUserIfMissing(newPassThrough, blockNumber, timestamp);

  let oldPassThrough = passThroughWallet.passThroughAccount;
  passThroughWallet.passThroughAccount = newPassThrough;
  passThroughWallet.save();

  // Need to update parentEntityTypes for downstream if this is
  // the diversifier factory updating the pass through.
  if (
    passThroughWallet.owner.toLowerCase() == DIVERSIFIER_FACTORY_ADDRESS.toLowerCase() &&
    oldPassThrough == ZERO_ADDRESS
  ) {
    let split = getSplit(passThroughWallet.passThroughAccount);
    if (!split) return;

    split.parentEntityType = 'diversifier';
    split.save();

    let recipients = split.recipients;
    for (let i: i32 = 0; i < recipients.length; i++) {
      let recipientId = recipients[i];
      // must exist
      let recipient = Recipient.load(recipientId) as Recipient;
      let swapper = Swapper.load(recipient.account); // TODO: check for other account types?
      if (swapper) {
        swapper.parentEntityType = 'diversifier';
        swapper.save();
      }
    }
  }

  // Save event?
}

export function handleSetPaused(event: SetPaused): void {
  let passThroughWalletId = event.address.toHexString();

  let passThroughWallet = getPassThroughWallet(passThroughWalletId);
  if (!passThroughWallet) return;

  // let timestamp = event.block.timestamp;
  // let txHash = event.transaction.hash.toHexString();
  // createTransactionIfMissing(txHash);
  // let logIdx = event.logIndex;

  if (event.block.number.toI32() > passThroughWallet.latestBlock) {
    passThroughWallet.latestBlock = event.block.number.toI32();
    passThroughWallet.latestActivity = event.block.timestamp;
  }

  passThroughWallet.paused = event.params.paused;
  passThroughWallet.save();

  // Save event?
}

export function handleOwnershipTransferred(event: OwnershipTransferred): void {
  let passThroughWalletId = event.address.toHexString();

  let passThroughWallet = getPassThroughWallet(passThroughWalletId);
  if (!passThroughWallet) return;

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;
  // let txHash = event.transaction.hash.toHexString();
  // createTransactionIfMissing(txHash);
  // let logIdx = event.logIndex;

  if (event.block.number.toI32() > passThroughWallet.latestBlock) {
    passThroughWallet.latestBlock = event.block.number.toI32();
    passThroughWallet.latestActivity = event.block.timestamp;
  }

  let newOwner = event.params.newOwner.toHexString();
  createUserIfMissing(newOwner, blockNumber, timestamp);
  passThroughWallet.owner = newOwner;
  passThroughWallet.save();

  // Save event?
}

export function handleExecCalls(event: ExecCalls): void {
  let passThroughWalletId = event.address.toHexString();

  let passThroughWallet = getPassThroughWallet(passThroughWalletId);
  if (!passThroughWallet) return;

  // let timestamp = event.block.timestamp;
  // let txHash = event.transaction.hash.toHexString();
  // createTransactionIfMissing(txHash);
  // let logIdx = event.logIndex;

  if (event.block.number.toI32() > passThroughWallet.latestBlock) {
    passThroughWallet.latestBlock = event.block.number.toI32();
    passThroughWallet.latestActivity = event.block.timestamp;
  }

  // How to process exec calls?
  log.warning('What to do for exec calls', []);

  passThroughWallet.save();

  // Save event?
}

export function handlePassThrough(event: PassThrough): void {
  let passThroughWalletId = event.address.toHexString();

  let passThroughWallet = getPassThroughWallet(passThroughWalletId);
  if (!passThroughWallet) return;

  // let timestamp = event.block.timestamp;
  // let txHash = event.transaction.hash.toHexString();
  // createTransactionIfMissing(txHash);
  // let logIdx = event.logIndex;

  if (event.block.number.toI32() > passThroughWallet.latestBlock) {
    passThroughWallet.latestBlock = event.block.number.toI32();
    passThroughWallet.latestActivity = event.block.timestamp;
  }

  let tokenIds = event.params.tokens;
  let amounts = event.params.amounts;
  for (let i: i32 = 0; i < tokenIds.length; i++) {
    let tokenId = tokenIds[i].toHexString();
    let amount = amounts[i];

    let token = new Token(tokenId);
    token.save();

    updateTokenRelease(passThroughWalletId, tokenId, amount);
  }

  passThroughWallet.save();
}

function updateTokenRelease(
  passThroughWalletId: string,
  tokenId: string,
  amount: BigInt,
): void {
  let passThroughWalletTokenBalanceId = createJointId([passThroughWalletId, tokenId]);
  let passThroughWalletTokenReleaseId = createJointId([
    TOKEN_RELEASE_PREFIX,
    passThroughWalletTokenBalanceId
  ]);
  let passThroughWalletTokenRelease = TokenRelease.load(passThroughWalletTokenReleaseId);
  if (!passThroughWalletTokenRelease) {
    passThroughWalletTokenRelease = new TokenRelease(passThroughWalletTokenReleaseId);
    passThroughWalletTokenRelease.account = passThroughWalletId;
    passThroughWalletTokenRelease.token = tokenId;
    passThroughWalletTokenRelease.amount = ZERO;
  }
  passThroughWalletTokenRelease.amount += amount;
  passThroughWalletTokenRelease.save();
}