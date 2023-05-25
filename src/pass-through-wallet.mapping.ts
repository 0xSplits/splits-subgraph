import { BigInt, Bytes, ethereum, log } from "@graphprotocol/graph-ts";
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
  CreatePassThroughWalletEvent,
  UpdatePassThroughAccountEvent,
  PassThroughFundsBalance,
  PassThroughFundsEvent,
  ReceivePassThroughFundsEvent,
  Split,
  TokenWithdrawal,
  PassThroughWalletSwapBalance,
  PassThroughWalletSwapBalanceOutput,
} from "../generated/schema";
import {
  createJointId,
  createTransactionIfMissing,
  createUserIfMissing,
  getAddressHexFromBytes32,
  getPassThroughWallet,
  getSplit,
  RECEIVE_PREFIX,
  TOKEN_RELEASE_PREFIX,
  TOKEN_WITHDRAWAL_USER_PREFIX,
  TRANSFER_EVENT_TOPIC,
  WETH_DEPOSIT_EVENT_TOPIC,
  WETH_WITHDRAWAL_EVENT_TOPIC,
  ZERO,
  ZERO_ADDRESS,
} from "./helpers";

const CREATE_PASS_THROUGH_WALLET_EVENT_PREFIX = "cptwe";
const UPDATE_PASS_THROUGH_ACCOUNT_EVENT_PREFIX = "uptae";
const PASS_THROUGH_FUNDS_EVENT_PREFIX = "ptfe";

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
  let createPassThroughWalletEventId = createJointId([CREATE_PASS_THROUGH_WALLET_EVENT_PREFIX, txHash, logIdx.toString()]);
  let createPassThroughWalletEvent = new CreatePassThroughWalletEvent(createPassThroughWalletEventId);
  createPassThroughWalletEvent.timestamp = timestamp;
  createPassThroughWalletEvent.transaction = txHash;
  createPassThroughWalletEvent.logIndex = logIdx;
  createPassThroughWalletEvent.account = passThroughWalletId;
  createPassThroughWalletEvent.passThroughAccount = passThroughAccount;
  createPassThroughWalletEvent.save();
}

export function handleSetPassThrough(event: SetPassThrough): void {
  let passThroughWalletId = event.address.toHexString();

  let passThroughWallet = getPassThroughWallet(passThroughWalletId);
  if (!passThroughWallet) return;

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  createTransactionIfMissing(txHash);
  let logIdx = event.logIndex;

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

  // Save event
  let updatePassThroughAccountEventId = createJointId([UPDATE_PASS_THROUGH_ACCOUNT_EVENT_PREFIX, txHash, logIdx.toString()]);
  let updatePassThroughAccountEvent = new UpdatePassThroughAccountEvent(updatePassThroughAccountEventId);
  updatePassThroughAccountEvent.timestamp = timestamp;
  updatePassThroughAccountEvent.transaction = txHash;
  updatePassThroughAccountEvent.logIndex = logIdx;
  updatePassThroughAccountEvent.account = passThroughWalletId;
  updatePassThroughAccountEvent.oldPassThroughAccount = oldPassThrough;
  updatePassThroughAccountEvent.newPassThroughAccount = newPassThrough;
  updatePassThroughAccountEvent.save();
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

  let blockNumber = event.block.number.toI32();
  let timestamp = event.block.timestamp;

  if (blockNumber > passThroughWallet.latestBlock) {
    passThroughWallet.latestBlock = blockNumber;
    passThroughWallet.latestActivity = timestamp;
  }

  handleOwnerSwap(passThroughWallet, event);

  passThroughWallet.save();
}

export function handlePassThrough(event: PassThrough): void {
  let passThroughWalletId = event.address.toHexString();

  let passThroughWallet = getPassThroughWallet(passThroughWalletId);
  if (!passThroughWallet) return;

  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  createTransactionIfMissing(txHash);
  let logIdx = event.logIndex;

  if (event.block.number.toI32() > passThroughWallet.latestBlock) {
    passThroughWallet.latestBlock = event.block.number.toI32();
    passThroughWallet.latestActivity = event.block.timestamp;
  }

  let tokenIds = event.params.tokens;
  let amounts = event.params.amounts;
  let stringTokenIds: string[] = [];
  for (let i: i32 = 0; i < tokenIds.length; i++) {
    let tokenId = tokenIds[i].toHexString();
    let amount = amounts[i];

    let token = new Token(tokenId);
    token.save();

    updateTokenRelease(passThroughWalletId, tokenId, amount);

    stringTokenIds.push(tokenId);
  }

  passThroughWallet.save();

  // Save event
  let passThroughFundsEventId = createJointId([PASS_THROUGH_FUNDS_EVENT_PREFIX, txHash, logIdx.toString()]);
  let passThroughFundsEvent = new PassThroughFundsEvent(passThroughFundsEventId);
  passThroughFundsEvent.timestamp = timestamp;
  passThroughFundsEvent.transaction = txHash;
  passThroughFundsEvent.logIndex = logIdx;
  passThroughFundsEvent.account = passThroughWalletId;
  passThroughFundsEvent.save();

  for (let i: i32 = 0; i < tokenIds.length; i++) {
    let tokenId = tokenIds[i].toHexString();
    let amount = amounts[i];
    let passThroughFundsBalanceId = createJointId([passThroughFundsEventId, tokenId]);
    let passThroughFundsBalance = new PassThroughFundsBalance(passThroughFundsBalanceId);
    passThroughFundsBalance.token = tokenId;
    passThroughFundsBalance.amount = amount;
    passThroughFundsBalance.passThroughFundsEvent = passThroughFundsEventId;
    passThroughFundsBalance.save();
  }

  let receivePassThroughFundsEventId = createJointId([RECEIVE_PREFIX, PASS_THROUGH_FUNDS_EVENT_PREFIX, txHash, logIdx.toString()]);
  let receivePassThroughFundsEvent = new ReceivePassThroughFundsEvent(receivePassThroughFundsEventId);
  receivePassThroughFundsEvent.timestamp = timestamp;
  receivePassThroughFundsEvent.logIndex = logIdx;
  receivePassThroughFundsEvent.account = passThroughWallet.passThroughAccount;
  receivePassThroughFundsEvent.passThroughFundsEvent = passThroughFundsEventId;
  receivePassThroughFundsEvent.save();
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

function handleOwnerSwap(
  passThroughWallet: PassThroughWallet,
  event: ExecCalls,
): void {
  if (passThroughWallet.parentEntityType != 'diversifier') return;

  let split = Split.load(passThroughWallet.passThroughAccount);
  if (!split) return;

  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  createTransactionIfMissing(txHash);
  let logIdx = event.logIndex;

  let calls = event.params.calls;
  for (let i: i32 = 0; i < calls.length; i++) {
    let toAddress = calls[i].to.toHexString();

    for (let i: i32 = 0; i < split.recipients.length; i++) {
      let recipientId = split.recipients[i];
      let recipient = Recipient.load(recipientId) as Recipient;
      let beneficiary = recipient.account;

      let swapper = Swapper.load(recipient.account);
      if (swapper) {
        beneficiary = swapper.beneficiary;
      }

      if (toAddress == beneficiary) {
        // Handle direct eth transfer to beneficiary
        let value = calls[i].value;
        updateSwapBalance(
          passThroughWallet.id,
          toAddress,
          ZERO_ADDRESS,
          value,
          ZERO_ADDRESS,
          value,
          timestamp,
          txHash,
          logIdx,
        )
      }
    }
  }

  let receipt = event.receipt as ethereum.TransactionReceipt;
  if (receipt) {
    let receiptLogs = receipt.logs;
    let pendingInputToken = ZERO_ADDRESS; // Default this to eth, if no from transfer picked up this was the input token
    let pendingInputAmount = BigInt.fromI32(0);

    for (let i: i32 = 0; i < receiptLogs.length; i++) {
      let receiptLog = receiptLogs[i];
      let topic0 = receiptLog.topics[0].toHexString();

      if (topic0 == TRANSFER_EVENT_TOPIC) {
        let token = receiptLog.address.toHexString();
        let fromAddress = getAddressHexFromBytes32(receiptLog.topics[1].toHexString());
        let toAddress = getAddressHexFromBytes32(receiptLog.topics[2].toHexString());
        let amount = BigInt.fromUnsignedBytes(Bytes.fromUint8Array(receiptLog.data.reverse()));

        if (fromAddress == passThroughWallet.id) {
          pendingInputToken = token;
          pendingInputAmount = amount;

          for (let i: i32 = 0; i < split.recipients.length; i++) {
            let recipientId = split.recipients[i];
            let recipient = Recipient.load(recipientId) as Recipient;
            let beneficiary = recipient.account;
      
            let swapper = Swapper.load(recipient.account);
            if (swapper) beneficiary = swapper.beneficiary;
      
            // Handle direct transfer from pass through wallet to recipient
            if (toAddress == beneficiary) {
              updateSwapBalance(
                passThroughWallet.id,
                beneficiary,
                pendingInputToken,
                pendingInputAmount,
                token,
                amount,
                timestamp,
                txHash,
                logIdx,
              );
              pendingInputToken = ZERO_ADDRESS;
              pendingInputAmount = BigInt.fromI32(0);
            }
          }
        } else {
          // TODO: need to capture input eth amount somehow still
          // Handle uniswap trade
          for (let i: i32 = 0; i < split.recipients.length; i++) {
            let recipientId = split.recipients[i];
            let recipient = Recipient.load(recipientId) as Recipient;
            let beneficiary = recipient.account;
      
            let swapper = Swapper.load(recipient.account);
            if (swapper) beneficiary = swapper.beneficiary;

            if (toAddress == beneficiary) {
              updateSwapBalance(
                passThroughWallet.id,
                beneficiary,
                pendingInputToken,
                pendingInputAmount,
                token,
                amount,
                timestamp,
                txHash,
                logIdx,
              );
              pendingInputToken = ZERO_ADDRESS;
              pendingInputAmount = BigInt.fromI32(0);
            }
          }
        }
      } else if (topic0 == WETH_WITHDRAWAL_EVENT_TOPIC) {
        // TODO: fix this. How can we know the recipient?
        let amount = BigInt.fromUnsignedBytes(Bytes.fromUint8Array(receiptLog.data.reverse()));
        updateSwapBalance(
          passThroughWallet.id,
          '', // Unknown beneficiary
          pendingInputToken,
          pendingInputAmount,
          ZERO_ADDRESS,
          amount,
          timestamp,
          txHash,
          logIdx,
        );
        pendingInputToken = ZERO_ADDRESS;
        pendingInputAmount = BigInt.fromI32(0);
      } else if (topic0 == WETH_DEPOSIT_EVENT_TOPIC) {
        // Just update the input amount, the outputs will be handled by other events
        let amount = BigInt.fromUnsignedBytes(Bytes.fromUint8Array(receiptLog.data.reverse()));
        updateSwapBalance(
          passThroughWallet.id,
          '', // Unknown beneficiary
          ZERO_ADDRESS,
          amount,
          null,
          BigInt.fromI32(0),
          timestamp,
          txHash,
          logIdx,
        )
      }
    }
  }
}

function updateSwapBalance(
  passThroughWalletId: string,
  recipient: string,
  inputTokenId: string,
  inputAmount: BigInt,
  outputTokenId: string | null,
  outputAmount: BigInt,
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt
): void {
  let swapBalanceId = createJointId([passThroughWalletId, inputTokenId]);
  let swapBalance = PassThroughWalletSwapBalance.load(swapBalanceId);
  if (!swapBalance) {
    swapBalance = new PassThroughWalletSwapBalance(swapBalanceId);
    swapBalance.passThroughWallet = passThroughWalletId;
    swapBalance.inputToken = inputTokenId;
    swapBalance.inputAmount = ZERO;
  }
  swapBalance.inputAmount += inputAmount;
  swapBalance.save();

  if (outputTokenId) {
    let swapBalanceOutputId = createJointId([swapBalanceId, outputTokenId]);
    let swapBalanceOutput = PassThroughWalletSwapBalanceOutput.load(swapBalanceOutputId);
    if (!swapBalanceOutput) {
      swapBalanceOutput = new PassThroughWalletSwapBalanceOutput(swapBalanceOutputId);
      swapBalanceOutput.passThroughWalletSwapBalance = swapBalanceId;
      swapBalanceOutput.token = outputTokenId;
      swapBalanceOutput.amount = ZERO;
    }
    swapBalanceOutput.amount += outputAmount;
    swapBalanceOutput.save();

    // Only need to update withdrawn for users. For all modules, swapped funds
    // will show up in their active balances.
    let user = User.load(recipient);
    if (user) {
      let tokenBalanceId = createJointId([recipient, outputTokenId]);
      let tokenWithdrawalId = createJointId([
        TOKEN_WITHDRAWAL_USER_PREFIX,
        tokenBalanceId
      ]);
      let tokenWithdrawal = TokenWithdrawal.load(tokenWithdrawalId);
      if (!tokenWithdrawal) {
        tokenWithdrawal = new TokenWithdrawal(tokenWithdrawalId);
        tokenWithdrawal.account = recipient;
        tokenWithdrawal.token = outputTokenId;
        tokenWithdrawal.amount = ZERO;
      }
      tokenWithdrawal.amount += outputAmount;
      tokenWithdrawal.save();
    }
  }

  // Save events
  // TODO
}