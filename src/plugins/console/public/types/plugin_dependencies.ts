/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import { ReactElement } from 'react';
import { HomePublicPluginSetup, HomePublicPluginStart } from '@kbn/home-plugin/public';
import { DevToolsSetup } from '@kbn/dev-tools-plugin/public';
import { UsageCollectionSetup, UsageCollectionStart } from '@kbn/usage-collection-plugin/public';
import { SharePluginSetup, SharePluginStart, LocatorPublic } from '@kbn/share-plugin/public';

import { ConsoleUILocatorParams } from './locator';
import { EmbeddableConsoleProps } from './embeddable_console';

export interface AppSetupUIPluginDependencies {
  home?: HomePublicPluginSetup;
  devTools: DevToolsSetup;
  share: SharePluginSetup;
  usageCollection?: UsageCollectionSetup;
}

export interface AppStartUIPluginDependencies {
  home?: HomePublicPluginStart;
  share: SharePluginStart;
  usageCollection?: UsageCollectionStart;
}

/**
 * Console plugin's setup service object
 */
export interface ConsolePluginSetup {
  /**
   * Public locator for the console UI
   */
  locator?: LocatorPublic<ConsoleUILocatorParams>;
}

/**
 * Console plugin's start service object
 */
export interface ConsolePluginStart {
  /**
   * renderEmbeddableConsole is available if the console UI is enabled. This function can be called to
   * render an embeddable version of the developer console on the page.
   */
  renderEmbeddableConsole?: (props?: EmbeddableConsoleProps) => ReactElement | null;
  /**
   * isEmbeddedConsoleAvailable is available if the embedded console can be rendered. Returns true when
   * called if the Embedded Console is currently rendered.
   */
  isEmbeddedConsoleAvailable?: () => boolean;
  /**
   * openEmbeddedConsole is available if the embedded console can be rendered. Calling
   * this function will open the embedded console on the page if it is currently rendered.
   */
  openEmbeddedConsole?: (content?: string) => void;
}
