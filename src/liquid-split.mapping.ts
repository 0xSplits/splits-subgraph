import { Address, BigInt, log } from "@graphprotocol/graph-ts";
import { CreateLS1155 } from "../generated/LiquidSplitFactory/LiquidSplitFactory";
import {
  CreateLiquidSplit,
  TransferSingle,
  LiquidSplit as LiquidSplitContract,
  TransferBatch
} from "../generated/LiquidSplit/LiquidSplit";
import { LiquidSplit as LiquidSplitTemplate } from '../generated/templates'
import {
  LiquidSplit,
  Holder,
  User,
} from "../generated/schema";
import { createJointId, createTransactionIfMissing, createUserIfMissing, getLiquidSplit, PERCENTAGE_SCALE, ZERO_ADDRESS } from "./helpers";

const FACTORY_GENERATED_TOTAL_SUPPLY = BigInt.fromI64(1e3 as i64);

export function handleCreateLiquidSplit(event: CreateLiquidSplit): void {
  let liquidSplitId = event.address.toHexString();

  let timestamp = event.block.timestamp;
  let txHash = event.transaction.hash.toHexString();
  createTransactionIfMissing(txHash);
  let logIdx = event.logIndex;

  // If a user already exists at this id, just return for now. Cannot have two
  // entities with the same id if they share an interface. Will handle this situation
  // in subgraph v2.
  let liquidSplitUser = User.load(liquidSplitId);
  if (liquidSplitUser) {
    log.warning('Trying to create a liquid split, but a user already exists: {}', [liquidSplitId]);
    return;
  }

  let liquidSplit = new LiquidSplit(liquidSplitId);
  liquidSplit.latestBlock = event.block.number.toI32();
  liquidSplit.isFactoryGenerated = false;

  // Fetch distributor fee and payout split
  let liquidSplitContract = LiquidSplitContract.bind(event.address);
  liquidSplit.distributorFee = liquidSplitContract.distributorFee();
  liquidSplit.split = liquidSplitContract.payoutSplit().toHexString();

  liquidSplit.save();

  LiquidSplitTemplate.create(event.address);

  // Save event
}

export function handleCreateLiquidSplitFromFactory(event: CreateLS1155): void {
  // The liquid split was already created from the abstract constructor's event,
  // just need to mark it as factory generated
  let liquidSplitId = event.params.ls.toHexString();
  let liquidSplit = getLiquidSplit(liquidSplitId);
  if (!liquidSplit) return;

  liquidSplit.isFactoryGenerated = true;
  liquidSplit.save();
}

export function handleTransferSingle1155(event: TransferSingle): void {
  let liquidSplitId = event.address.toHexString();

  let liquidSplit = getLiquidSplit(liquidSplitId);
  if (!liquidSplit) return;

  let fromAddress = event.params.from.toHexString();
  let toAddress = event.params.to.toHexString();
  if (liquidSplit.isFactoryGenerated) {
    if (fromAddress != ZERO_ADDRESS) {
      let fromHolder = getHolder(fromAddress, liquidSplitId);
      fromHolder.ownership -= event.params.amount * PERCENTAGE_SCALE / FACTORY_GENERATED_TOTAL_SUPPLY;
      fromHolder.save();
    }
    if (toAddress != ZERO_ADDRESS) {
      let toHolder = getHolder(toAddress, liquidSplitId);
      toHolder.ownership += event.params.amount * PERCENTAGE_SCALE / FACTORY_GENERATED_TOTAL_SUPPLY;
      toHolder.save();
    }
  } else {
    // updateHolderOwnershipNonFactoryLiquidSplit(event.address, fromAddress, toAddress);
  }

  // Save event
}

export function handleTransferBatch1155(event: TransferBatch): void {
  let liquidSplitId = event.address.toHexString();

  let liquidSplit = getLiquidSplit(liquidSplitId);
  if (!liquidSplit) return;

  let fromAddress = event.params.from.toHexString();
  let toAddress = event.params.to.toHexString();
  if (liquidSplit.isFactoryGenerated) {
    if (fromAddress != ZERO_ADDRESS) {
      let fromHolder = getHolder(fromAddress, liquidSplitId);
      event.params.amounts.forEach((amount) => {
        fromHolder.ownership -= amount * PERCENTAGE_SCALE / FACTORY_GENERATED_TOTAL_SUPPLY;  
      })
      fromHolder.save();
    }
    if (toAddress != ZERO_ADDRESS) {
      let toHolder = getHolder(toAddress, liquidSplitId);
      event.params.amounts.forEach((amount) => {
        toHolder.ownership += amount * PERCENTAGE_SCALE / FACTORY_GENERATED_TOTAL_SUPPLY;
      })
      toHolder.save();
    }
  } else {
    // updateHolderOwnershipNonFactoryLiquidSplit(event.address, fromAddress, toAddress);
  }
}

function getHolder(accountId: string, liquidSplitId: string): Holder {
  let holderId = createJointId([liquidSplitId, accountId]);
  let holder = Holder.load(holderId);
  if (!holder) {
    createUserIfMissing(accountId);
    holder = new Holder(holderId);
    holder.liquidSplit = liquidSplitId;
    holder.account = accountId;
  }
  
  return holder;
}

function updateHolderOwnershipNonFactoryLiquidSplit(liquidSplitAddress: Address, fromAddress: string, toAddress: string) {
  let liquidSplitContract = LiquidSplitContract.bind(liquidSplitAddress);
  let liquidSplitId = liquidSplitAddress.toHexString();
  if (fromAddress != ZERO_ADDRESS) {
    let fromHolder = getHolder(fromAddress, liquidSplitId);
    fromHolder.ownership = liquidSplitContract.scaledPercentBalanceOf(fromAddress);
    fromHolder.save();
  }
  if (toAddress != ZERO_ADDRESS) {
    let toHolder = getHolder(toAddress, liquidSplitId);
    toHolder.ownership = liquidSplitContract.scaledPercentBalanceOf(toAddress);
    toHolder.save();
  }
}
