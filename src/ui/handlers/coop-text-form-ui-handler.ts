import type { ModalConfig } from "#types/ui-types";
import { FormModalUiHandler, type InputFieldConfig } from "#ui/form-modal-ui-handler";

/** What the one-line text form shows and does. The first button action gets the typed text, the second cancels. */
export interface CoopTextFormConfig extends ModalConfig {
  title: string;
  label: string;
  /** Label of the confirm button (the other one is "Cancel") */
  confirm?: string;
  /** What the box starts with */
  initial?: string;
}

/** A small one-line text prompt (used in the co-op screens, e.g. for the relay address or a profile name). */
export class CoopTextFormUiHandler extends FormModalUiHandler {
  private current: CoopTextFormConfig | null = null;

  getModalTitle(config?: ModalConfig): string {
    return ((config ?? this.current) as CoopTextFormConfig | null)?.title ?? "";
  }

  getWidth(_config?: ModalConfig): number {
    return 180;
  }

  getMargin(_config?: ModalConfig): [number, number, number, number] {
    return [0, 0, 48, 0];
  }

  getButtonLabels(config?: ModalConfig): string[] {
    return [((config ?? this.current) as CoopTextFormConfig | null)?.confirm ?? "OK", "Cancel"];
  }

  override getInputFieldConfigs(): InputFieldConfig[] {
    return [{ label: this.current?.label ?? "" }];
  }

  show(args: any[]): boolean {
    this.current = (args[0] as CoopTextFormConfig | undefined) ?? null;
    if (!super.show(args)) {
      return false;
    }
    for (const input of this.inputs ?? []) {
      input.text = this.current?.initial ?? "";
    }
    const config = args[0] as CoopTextFormConfig;
    this.submitAction = () => {
      this.sanitizeInputs();
      config.buttonActions[0](this.inputs[0].text.trim());
      return true;
    };
    return true;
  }
}
