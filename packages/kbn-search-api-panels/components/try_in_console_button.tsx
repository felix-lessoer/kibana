/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import React from 'react';

import { EuiButtonEmpty } from '@elastic/eui';
import type { ApplicationStart } from '@kbn/core-application-browser';
import type { SharePluginStart } from '@kbn/share-plugin/public';
import type { ConsolePluginStart } from '@kbn/console-plugin/public';

import { FormattedMessage } from '@kbn/i18n-react';
import { compressToEncodedURIComponent } from 'lz-string';

export interface TryInConsoleButtonProps {
  request: string;
  application?: ApplicationStart;
  consolePlugin?: ConsolePluginStart;
  sharePlugin: SharePluginStart;
}
export const TryInConsoleButton = ({
  request,
  application,
  consolePlugin,
  sharePlugin,
}: TryInConsoleButtonProps) => {
  const { url } = sharePlugin;
  const canShowDevtools = !!application?.capabilities?.dev_tools?.show;
  if (!canShowDevtools || !url) return null;

  const devToolsDataUri = compressToEncodedURIComponent(request);
  const consolePreviewLink = url.locators.get('CONSOLE_APP_LOCATOR')?.useUrl(
    {
      loadFrom: `data:text/plain,${devToolsDataUri}`,
    },
    undefined,
    [request]
  );
  if (!consolePreviewLink) return null;

  const onClick = () => {
    const embeddedConsoleAvailable =
      (consolePlugin?.openEmbeddedConsole !== undefined &&
        consolePlugin?.isEmbeddedConsoleAvailable?.()) ??
      false;
    if (embeddedConsoleAvailable) {
      consolePlugin!.openEmbeddedConsole!(request);
    } else {
      window.open(consolePreviewLink, '_blank', 'noreferrer');
    }
  };

  return (
    <EuiButtonEmpty onClick={onClick} iconType="popout" size="s">
      <FormattedMessage
        id="searchApiPanels.welcomeBanner.tryInConsoleButton"
        defaultMessage="Try in Console"
      />
    </EuiButtonEmpty>
  );
};
