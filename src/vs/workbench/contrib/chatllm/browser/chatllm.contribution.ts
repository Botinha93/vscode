/*---------------------------------------------------------------------------------------------
 *  Chatllm: keep the bundled GitHub Copilot extension disabled by default unless the
 *  user opts in via the `chatllm.copilot.enabled` setting.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IExtensionIdentifier, IGlobalExtensionEnablementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IChatEntitlementService } from '../../../services/chat/common/chatEntitlementService.js';

const COPILOT_CHAT_ID: IExtensionIdentifier = { id: 'GitHub.copilot-chat' };
const COPILOT_COMPLETIONS_ID: IExtensionIdentifier = { id: 'GitHub.copilot' };
const COPILOT_EXTENSIONS: readonly IExtensionIdentifier[] = [COPILOT_CHAT_ID, COPILOT_COMPLETIONS_ID];
const SETTING_KEY = 'chatllm.copilot.enabled';

class ChatllmCopilotEnablementContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatllmCopilotEnablement';

	private applying = false;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IGlobalExtensionEnablementService private readonly enablementService: IGlobalExtensionEnablementService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService private readonly hostService: IHostService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
	) {
		super();

		this.applyNativeChatVisibility();
		void this.syncOnStartup();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SETTING_KEY)) {
				this.applyNativeChatVisibility();
				void this.onConfigChange();
			}
		}));
	}

	private applyNativeChatVisibility(): void {
		// When Copilot is disabled (the Chatllm default), keep the entire native Chat surface hidden.
		// The Chatllm experience lives in its own webview view in the secondary side bar.
		const hideNative = !this.isCopilotEnabledSetting();
		this.chatEntitlementService.setForceHidden(hideNative);
	}

	private isCopilotEnabledSetting(): boolean {
		return this.configurationService.getValue<boolean>(SETTING_KEY) === true;
	}

	private isCopilotDisabledInStorage(identifier: IExtensionIdentifier): boolean {
		return this.enablementService.getDisabledExtensions().some(e => areSameExtensions(e, identifier));
	}

	private async setDisabled(identifier: IExtensionIdentifier, disabled: boolean): Promise<boolean> {
		this.applying = true;
		try {
			return disabled
				? await this.enablementService.disableExtension(identifier, 'chatllm')
				: await this.enablementService.enableExtension(identifier, 'chatllm');
		} finally {
			this.applying = false;
		}
	}

	private async syncOnStartup(): Promise<void> {
		const wantDisabled = !this.isCopilotEnabledSetting();
		for (const id of COPILOT_EXTENSIONS) {
			const isDisabled = this.isCopilotDisabledInStorage(id);
			if (wantDisabled && !isDisabled) {
				await this.setDisabled(id, true);
			} else if (!wantDisabled && isDisabled) {
				await this.setDisabled(id, false);
			}
		}
	}

	private async onConfigChange(): Promise<void> {
		if (this.applying) {
			return;
		}
		const wantDisabled = !this.isCopilotEnabledSetting();
		let changed = false;
		for (const id of COPILOT_EXTENSIONS) {
			const isDisabled = this.isCopilotDisabledInStorage(id);
			if (wantDisabled !== isDisabled) {
				if (await this.setDisabled(id, wantDisabled)) {
					changed = true;
				}
			}
		}
		if (changed) {
			this.notificationService.prompt(
				Severity.Info,
				wantDisabled
					? localize('chatllm.copilot.disabled', "GitHub Copilot has been disabled. Reload the window to fully apply the change.")
					: localize('chatllm.copilot.enabled', "GitHub Copilot has been enabled. Reload the window to start it."),
				[{
					label: localize('chatllm.copilot.reload', "Reload Window"),
					run: () => this.hostService.reload()
				}]
			);
		}
	}
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'chatllm',
	order: 100,
	type: 'object',
	title: localize('chatllm.title', "Chatllm"),
	properties: {
		[SETTING_KEY]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('chatllm.copilot.enabled.description', "Enable the bundled GitHub Copilot extensions. Disabled by default in Chatllm; toggling requires a window reload."),
		},
	},
});

registerWorkbenchContribution2(
	ChatllmCopilotEnablementContribution.ID,
	ChatllmCopilotEnablementContribution,
	WorkbenchPhase.BlockRestore,
);
