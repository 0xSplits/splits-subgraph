import { BigInt, Address } from "@graphprotocol/graph-ts";
import {
  Split,
  Recipient,
  Token,
  TokenInternalBalance,
  TokenWithdrawal,
  User
} from "../generated/schema";

export const PERCENTAGE_SCALE = BigInt.fromI64(1e6 as i64);
export const ZERO = BigInt.fromI32(0);
export const ONE = BigInt.fromI32(1);

export const TOKEN_WITHDRAWAL_PREFIX = "w";
export const TOKEN_INTERNAL_BALANCE_PREFIX = "ib";
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

export function distributeSplit(
  splitId: string,
  tokenId: string,
  amount: BigInt,
  distributorAddress: Address
): void {
  let token = new Token(tokenId);
  token.save();

  let splitTokenBalanceId = createJointId([splitId, tokenId]);

  let splitTokenWithdrawalId = createJointId([
    TOKEN_WITHDRAWAL_PREFIX,
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

  // must exist
  let split = Split.load(splitId) as Split;

  // doesn't know msg.sender; only affects advance users distributing from contracts
  // assuming they don't explicitly use distributorFee to repoint the proceeds elsewhere;
  // likely very rare & can fix accounting on withdrawal anyway)
  let distributorFee = split.distributorFee;
  if (distributorFee != ZERO) {
    let distributorAmount = (amount * distributorFee) / PERCENTAGE_SCALE;
    amount -= distributorAmount;

    // if address is zero, dont give to any account (don't know msg.sender)
    if (distributorAddress != Address.zero()) {
      // 'Create' the user in case they don't exist yet
      let user = new User(distributorAddress.toHexString());
      user.save();

      addBalanceToUser(
        distributorAddress.toHexString(),
        tokenId,
        distributorAmount
      );
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
  }
}

export function handleTokenWithdrawal(
  accountId: string,
  tokenId: string,
  amount: BigInt
): void {
  let tokenBalanceId = createJointId([accountId, tokenId]);

  let tokenWithdrawalId = createJointId([
    TOKEN_WITHDRAWAL_PREFIX,
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
  let tokenInternalBalance = new TokenInternalBalance(tokenInternalBalanceId);
  tokenInternalBalance.account = accountId
  tokenInternalBalance.token = tokenId
  tokenInternalBalance.amount = ONE;
  tokenInternalBalance.save();
}
