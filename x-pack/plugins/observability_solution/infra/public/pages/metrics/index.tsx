/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';

import React, { useContext } from 'react';
import { Routes, Route } from '@kbn/shared-ux-router';

import {
  EuiErrorBoundary,
  EuiHeaderLinks,
  EuiHeaderLink,
  EuiFlexGroup,
  EuiFlexItem,
} from '@elastic/eui';
import { useKibana, useUiSetting } from '@kbn/kibana-react-plugin/public';
import { HeaderMenuPortal, useLinkProps } from '@kbn/observability-shared-plugin/public';
import { enableInfrastructureHostsView } from '@kbn/observability-plugin/common';
import { useKibanaContextForPlugin } from '../../hooks/use_kibana';
import { MetricsSourceConfigurationProperties } from '../../../common/metrics_sources';
import { HelpCenterContent } from '../../components/help_center_content';
import { useReadOnlyBadge } from '../../hooks/use_readonly_badge';
import { MetricsExplorerOptionsContainer } from './metrics_explorer/hooks/use_metrics_explorer_options';
import { WithMetricsExplorerOptionsUrlState } from '../../containers/metrics_explorer/with_metrics_explorer_options_url_state';
import { MetricsExplorerPage } from './metrics_explorer';
import { SnapshotPage } from './inventory_view';
import { NodeDetail } from './metric_detail';
import { MetricsSettingsPage } from './settings';
import { SourceLoadingPage } from '../../components/source_loading_page';
import { MetricsAlertDropdown } from '../../alerting/common/components/metrics_alert_dropdown';
import { AlertPrefillProvider } from '../../alerting/use_alert_prefill';
import { InfraMLCapabilitiesProvider } from '../../containers/ml/infra_ml_capabilities';
import { AnomalyDetectionFlyout } from '../../components/ml/anomaly_detection/anomaly_detection_flyout';
import { HeaderActionMenuContext } from '../../utils/header_action_menu_provider';
import { CreateDerivedIndexPattern, useSourceContext } from '../../containers/metrics_source';
import { NotFoundPage } from '../404';
import { ReactQueryProvider } from '../../containers/react_query_provider';
import { usePluginConfig } from '../../containers/plugin_config_context';
import { HostsPage } from './hosts';
import { RedirectWithQueryParams } from '../../utils/redirect_with_query_params';

const ADD_DATA_LABEL = i18n.translate('xpack.infra.metricsHeaderAddDataButtonLabel', {
  defaultMessage: 'Add data',
});

export const InfrastructurePage = () => {
  const {
    observabilityAIAssistant: { ObservabilityAIAssistantActionMenuItem },
  } = useKibanaContextForPlugin().services;
  const config = usePluginConfig();
  const uiCapabilities = useKibana().services.application?.capabilities;
  const { setHeaderActionMenu, theme$ } = useContext(HeaderActionMenuContext);
  const isHostsViewEnabled = useUiSetting(enableInfrastructureHostsView);

  const settingsTabTitle = i18n.translate('xpack.infra.metrics.settingsTabTitle', {
    defaultMessage: 'Settings',
  });

  const kibana = useKibana();

  const { source, createDerivedIndexPattern } = useSourceContext();

  useReadOnlyBadge(!uiCapabilities?.infrastructure?.save);

  const settingsLinkProps = useLinkProps({
    app: 'metrics',
    pathname: 'settings',
  });

  return (
    <EuiErrorBoundary>
      <ReactQueryProvider>
        <AlertPrefillProvider>
          <InfraMLCapabilitiesProvider>
            <HelpCenterContent
              feedbackLink="https://discuss.elastic.co/c/metrics"
              appName={i18n.translate('xpack.infra.header.infrastructureHelpAppName', {
                defaultMessage: 'Metrics',
              })}
            />
            {setHeaderActionMenu && theme$ && (
              <HeaderMenuPortal setHeaderActionMenu={setHeaderActionMenu} theme$={theme$}>
                <EuiFlexGroup responsive={false} gutterSize="s">
                  <EuiFlexItem>
                    <EuiHeaderLinks gutterSize="xs">
                      <EuiHeaderLink color={'text'} {...settingsLinkProps}>
                        {settingsTabTitle}
                      </EuiHeaderLink>
                      <Route path={'/inventory'} component={AnomalyDetectionFlyout} />
                      <Route
                        path={'/hosts'}
                        render={() => {
                          return <AnomalyDetectionFlyout hideJobType hideSelectGroup />;
                        }}
                      />
                      <Route
                        path={'/detail/host'}
                        render={() => {
                          return <AnomalyDetectionFlyout hideJobType hideSelectGroup />;
                        }}
                      />
                      {config.featureFlags.alertsAndRulesDropdownEnabled && (
                        <MetricsAlertDropdown />
                      )}
                      <EuiHeaderLink
                        href={kibana.services?.application?.getUrlForApp('/integrations/browse')}
                        color="primary"
                        iconType="indexOpen"
                      >
                        {ADD_DATA_LABEL}
                      </EuiHeaderLink>
                    </EuiHeaderLinks>
                  </EuiFlexItem>
                  {ObservabilityAIAssistantActionMenuItem ? (
                    <EuiFlexItem>
                      <ObservabilityAIAssistantActionMenuItem />
                    </EuiFlexItem>
                  ) : null}
                </EuiFlexGroup>
              </HeaderMenuPortal>
            )}

            <Routes>
              <Route path="/inventory" component={SnapshotPage} />
              {config.featureFlags.metricsExplorerEnabled && (
                <Route
                  path="/explorer"
                  render={() => (
                    <MetricsExplorerOptionsContainer>
                      <WithMetricsExplorerOptionsUrlState />
                      {source?.configuration ? (
                        <PageContent
                          configuration={source.configuration}
                          createDerivedIndexPattern={createDerivedIndexPattern}
                        />
                      ) : (
                        <SourceLoadingPage />
                      )}
                    </MetricsExplorerOptionsContainer>
                  )}
                />
              )}

              <Route path="/detail/:type/:node" component={NodeDetail} />
              {isHostsViewEnabled && <Route path="/hosts" component={HostsPage} />}
              <Route path="/settings" component={MetricsSettingsPage} />

              <RedirectWithQueryParams from="/snapshot" exact to="/inventory" />
              <RedirectWithQueryParams from="/metrics-explorer" exact to="/explorer" />
              <RedirectWithQueryParams from="/" exact to="/inventory" />

              <Route render={() => <NotFoundPage title="Infrastructure" />} />
            </Routes>
          </InfraMLCapabilitiesProvider>
        </AlertPrefillProvider>
      </ReactQueryProvider>
    </EuiErrorBoundary>
  );
};

const PageContent = (props: {
  configuration: MetricsSourceConfigurationProperties;
  createDerivedIndexPattern: CreateDerivedIndexPattern;
}) => {
  const { createDerivedIndexPattern, configuration } = props;

  return (
    <MetricsExplorerPage derivedIndexPattern={createDerivedIndexPattern()} source={configuration} />
  );
};
