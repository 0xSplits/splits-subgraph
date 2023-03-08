import { CreateRecoup } from "../generated/Recoup/Recoup";
import {
  WaterfallTranche,
  Split,
} from "../generated/schema";
import {
  createJointId,
  getWaterfallModule,
} from "./helpers";

export function handleCreateRecoup(event: CreateRecoup): void {
  let waterfallModuleId = event.params.waterfallModule.toHexString();
  let waterfallModule = getWaterfallModule(waterfallModuleId);
  if (!waterfallModule) return;

  waterfallModule.parentEntityType = 'recoup';
  waterfallModule.save();

  let i: i32 = 0;
  let hasReachedResidual = false;
  while (!hasReachedResidual) {
    let waterfallTrancheId = createJointId([waterfallModuleId, i.toString()]);
    let waterfallTranche = WaterfallTranche.load(waterfallTrancheId) as WaterfallTranche;
    i++;

    if (!waterfallTranche.size) {
      hasReachedResidual = true;
    }

    let recipientId = waterfallTranche.recipient;
    let split = Split.load(recipientId);
    if (split) {
      split.parentEntityType = 'recoup';
      split.save();
    }
  }
}