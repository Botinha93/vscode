/*---------------------------------------------------------------------------------------------
 *  LiberIDE: gate native GitHub Copilot UI (chat view, Open Agents, etc.) behind
 *  `liberide.copilot.enabled` without disabling Copilot extensions (LM API).
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import product from '../../../../platform/product/common/product.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IProductService } from '../../../../platform/product/common/productService.js';

export const isLiberideProductBuild = product.applicationName === 'liberide' || product.nameShort === 'LiberIDE';

export const LiberideProductContext = new RawContextKey<boolean>('liberide.isProduct', isLiberideProductBuild);

export const LIBERIDE_COPILOT_UI_ENABLED_CONFIG = 'liberide.copilot.enabled';

/**
 * True when built-in Copilot chat / agents chrome should be shown.
 * Non-LiberIDE products are always allowed; LiberIDE requires the user setting.
 */
export const LiberideNativeCopilotUiEnabledExpr = ContextKeyExpr.or(
	LiberideProductContext.negate(),
	ContextKeyExpr.equals(`config.${LIBERIDE_COPILOT_UI_ENABLED_CONFIG}`, true),
);

export function isLiberideProduct(productService: IProductService): boolean {
	return productService.applicationName === 'liberide' || productService.nameShort === 'LiberIDE';
}

export const liberideCopilotUiEnabledDescription = localize(
	'liberide.copilot.enabled.description',
	'Show the bundled GitHub Copilot chat view and agents window entry points. Copilot model access via the Language Model API can remain enabled separately.',
);
