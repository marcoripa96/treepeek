import { WebHaptics, type HapticInput, type TriggerOptions } from "web-haptics";

let instance: WebHaptics | null = null;

function get(): WebHaptics | null {
  if (typeof window === "undefined") return null;
  if (!instance) instance = new WebHaptics();
  return instance;
}

export function haptic(input?: HapticInput, options?: TriggerOptions): void {
  void get()?.trigger(input, options);
}

export const hapticSelection = (): void => haptic("selection");
export const hapticLight = (): void => haptic("light");
export const hapticMedium = (): void => haptic("medium");
export const hapticHeavy = (): void => haptic("heavy");
export const hapticSoft = (): void => haptic("soft");
export const hapticRigid = (): void => haptic("rigid");
export const hapticSuccess = (): void => haptic("success");
export const hapticWarning = (): void => haptic("warning");
export const hapticError = (): void => haptic("error");
