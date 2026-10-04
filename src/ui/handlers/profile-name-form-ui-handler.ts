import type { ModalConfig } from "#types/ui-types";
import { FormModalUiHandler, type InputFieldConfig } from "#ui/form-modal-ui-handler";

/** A small form that asks for the nickname of the local profile to play as. */
export class ProfileNameFormUiHandler extends FormModalUiHandler {
  getModalTitle(_config?: ModalConfig): string {
    return "Profile nickname";
  }

  getWidth(_config?: ModalConfig): number {
    return 160;
  }

  getMargin(_config?: ModalConfig): [number, number, number, number] {
    return [0, 0, 48, 0];
  }

  getButtonLabels(_config?: ModalConfig): string[] {
    return ["Switch", "Cancel"];
  }

  override getInputFieldConfigs(): InputFieldConfig[] {
    return [{ label: "Nickname" }];
  }

  show(args: any[]): boolean {
    if (!super.show(args)) {
      return false;
    }
    for (const input of this.inputs ?? []) {
      input.text = "";
    }
    const config = args[0] as ModalConfig;
    this.submitAction = () => {
      this.sanitizeInputs();
      config.buttonActions[0](this.inputs[0].text);
      return true;
    };
    return true;
  }
}
