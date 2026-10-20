/*---------------------------------------------------------------------------------------------
 *  Chatllm / LiberIDE: hide native GitHub Copilot UI unless the user opts in.
 *  LiberIDE keeps Copilot extensions enabled for the Language Model API.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IExtensionIdentifier, IGlobalExtensionEnablementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IChatEntitlementService } from '../../../services/chat/common/chatEntitlementService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { ChatViewContainerId } from '../../chat/browser/chat.js';
import {
	LIBERIDE_COPILOT_UI_ENABLED_CONFIG,
	LiberideProductContext,
	isLiberideProduct,
	liberideCopilotUiEnabledDescription,
} from './liberideCopilotUi.js';

const COPILOT_CHAT_ID: IExtensionIdentifier = { id: 'GitHub.copilot-chat' };
const COPILOT_COMPLETIONS_ID: IExtensionIdentifier = { id: 'GitHub.copilot' };
const COPILOT_EXTENSIONS: readonly IExtensionIdentifier[] = [COPILOT_CHAT_ID, COPILOT_COMPLETIONS_ID];
const CHATLLM_SETTING_KEY = 'chatllm.copilot.enabled';
const LIBERIDE_CHAT_CONTAINER_ID = 'liberide-chat';

class ChatllmCopilotEnablementContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatllmCopilotEnablement';

	private applying = false;
	private readonly liberideProduct: boolean;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IGlobalExtensionEnablementService private readonly enablementService: IGlobalExtensionEnablementService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService private readonly hostService: IHostService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@IProductService productService: IProductService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
	) {
		super();

		this.liberideProduct = isLiberideProduct(productService);
		LiberideProductContext.bindTo(contextKeyService).set(this.liberideProduct);

		this.applyNativeChatVisibility();
		void this.syncOnStartup();
		void this.lifecycleService.when(LifecyclePhase.Restored).then(() => this.ensureAuxiliaryBarShowsLiberideChat());

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(this.copilotUiSettingKey())) {
				this.applyNativeChatVisibility();
				void this.ensureAuxiliaryBarShowsLiberideChat();
				if (!this.liberideProduct) {
					void this.onConfigChange();
				}
			}
		}));
	}

	private copilotUiSettingKey(): string {
		return this.liberideProduct ? LIBERIDE_COPILOT_UI_ENABLED_CONFIG : CHATLLM_SETTING_KEY;
	}

	private isNativeCopilotUiEnabled(): boolean {
		return this.configurationService.getValue<boolean>(this.copilotUiSettingKey()) === true;
	}

	private applyNativeChatVisibility(): void {
		const hideNative = !this.isNativeCopilotUiEnabled();
		this.chatEntitlementService.setForceHidden(hideNative);
	}

	private async ensureAuxiliaryBarShowsLiberideChat(): Promise<void> {
		if (!this.liberideProduct || this.isNativeCopilotUiEnabled()) {
			return;
		}
		const activeId = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)?.getId();
		if (activeId === ChatViewContainerId) {
			await this.paneCompositeService.openPaneComposite(LIBERIDE_CHAT_CONTAINER_ID, ViewContainerLocation.AuxiliaryBar, true);
		}
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
		if (this.liberideProduct) {
			return;
		}
		const wantDisabled = !this.isNativeCopilotUiEnabled();
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
		const wantDisabled = !this.isNativeCopilotUiEnabled();
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
		[CHATLLM_SETTING_KEY]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('chatllm.copilot.enabled.description', "Enable the bundled GitHub Copilot extensions. Disabled by default in Chatllm; toggling requires a window reload."),
		},
		[LIBERIDE_COPILOT_UI_ENABLED_CONFIG]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: liberideCopilotUiEnabledDescription,
		},
	},
});

registerWorkbenchContribution2(
	ChatllmCopilotEnablementContribution.ID,
	ChatllmCopilotEnablementContribution,
	WorkbenchPhase.BlockRestore,
);
