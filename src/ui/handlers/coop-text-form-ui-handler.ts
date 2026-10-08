import type { ModalConfig } from "#types/ui-types";
import { FormModalUiHandler, type InputFieldConfig } from "#ui/form-modal-ui-handler";

/** What a one-line text form does. The first button action gets the typed text, the second cancels. */
export interface CoopTextFormConfig extends ModalConfig {
  /** What the box starts with */
  initial?: string;
}

/**
 * A small one-line text prompt. The title, label and button are fixed when the screen is built (the form lays
 * itself out once), so each different prompt is its own subclass.
 */
abstract class CoopTextFormUiHandler extends FormModalUiHandler {
  protected abstract readonly title: string;
  protected abstract readonly label: string;
  protected abstract readonly confirmLabel: string;

  getModalTitle(_config?: ModalConfig): string {
    return this.title;
  }

  getWidth(_config?: ModalConfig): number {
    return 160;
  }

  getMargin(_config?: ModalConfig): [number, number, number, number] {
    return [0, 0, 48, 0];
  }

  getButtonLabels(_config?: ModalConfig): string[] {
    return [this.confirmLabel, "Cancel"];
  }

  override getInputFieldConfigs(): InputFieldConfig[] {
    return [{ label: this.label }];
  }

  show(args: any[]): boolean {
    if (!super.show(args)) {
      return false;
    }
    const config = args[0] as CoopTextFormConfig;
    for (const input of this.inputs ?? []) {
      input.text = config.initial ?? "";
    }
    this.submitAction = () => {
      this.sanitizeInputs();
      config.buttonActions[0](this.inputs[0].text.trim());
      return true;
    };
    return true;
  }
}

/** Asks for the address of a relay (the host's VPN or LAN address). */
export class CoopServerFormUiHandler extends CoopTextFormUiHandler {
  protected readonly title = "Relay address";
  protected readonly label = "Address";
  protected readonly confirmLabel = "Connect";
}

/** Asks for the nickname of a new profile. */
export class CoopProfileFormUiHandler extends CoopTextFormUiHandler {
  protected readonly title = "New profile";
  protected readonly label = "Nickname";
  protected readonly confirmLabel = "Create";
}
