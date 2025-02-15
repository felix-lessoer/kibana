/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { CoreStart } from '@kbn/core/public';
import moment from 'moment';
import { takeUntil, distinctUntilChanged, skip } from 'rxjs/operators';
import { from } from 'rxjs';
import React from 'react';
import { KibanaContextProvider } from '@kbn/kibana-react-plugin/public';
import { toMountPoint } from '@kbn/react-kibana-mount';
import type { DataViewsContract } from '@kbn/data-views-plugin/public';
import { getInitialGroupsMap } from '../../application/components/job_selector/job_selector';
import { getMlGlobalServices } from '../../application/app';
import type { JobId } from '../../../common/types/anomaly_detection_jobs';
import { JobSelectorFlyout } from './components/job_selector_flyout';

/**
 * Handles Anomaly detection jobs selection by a user.
 * Intended to use independently of the ML app context,
 * for instance on the dashboard for embeddables initialization.
 *
 * @param coreStart
 * @param selectedJobIds
 */
export async function resolveJobSelection(
  coreStart: CoreStart,
  dataViews: DataViewsContract,
  selectedJobIds?: JobId[],
  singleSelection: boolean = false
): Promise<{ jobIds: string[]; groups: Array<{ groupId: string; jobIds: string[] }> }> {
  const {
    http,
    uiSettings,
    theme,
    i18n,
    application: { currentAppId$ },
  } = coreStart;

  return new Promise(async (resolve, reject) => {
    try {
      const maps = {
        groupsMap: getInitialGroupsMap([]),
        jobsMap: {},
      };
      const tzConfig = uiSettings.get('dateFormat:tz');
      const dateFormatTz = tzConfig !== 'Browser' ? tzConfig : moment.tz.guess();

      const onFlyoutClose = () => {
        flyoutSession.close();
        reject();
      };

      const onSelectionConfirmed = async ({
        jobIds,
        groups,
      }: {
        jobIds: string[];
        groups: Array<{
          groupId: string;
          jobIds: string[];
        }>;
      }) => {
        await flyoutSession.close();
        resolve({
          jobIds,
          groups,
        });
      };

      const flyoutSession = coreStart.overlays.openFlyout(
        toMountPoint(
          <KibanaContextProvider
            services={{ ...coreStart, mlServices: getMlGlobalServices(http, dataViews) }}
          >
            <JobSelectorFlyout
              selectedIds={selectedJobIds}
              withTimeRangeSelector={false}
              dateFormatTz={dateFormatTz}
              singleSelection={singleSelection}
              timeseriesOnly={true}
              onFlyoutClose={onFlyoutClose}
              onSelectionConfirmed={onSelectionConfirmed}
              maps={maps}
            />
          </KibanaContextProvider>,
          { theme, i18n }
        ),
        {
          'data-test-subj': 'mlFlyoutJobSelector',
          ownFocus: true,
          closeButtonProps: { 'aria-label': 'jobSelectorFlyout' },
        }
      );

      // Close the flyout when user navigates out of the current plugin
      currentAppId$
        .pipe(skip(1), takeUntil(from(flyoutSession.onClose)), distinctUntilChanged())
        .subscribe(() => {
          flyoutSession.close();
        });
    } catch (error) {
      reject(error);
    }
  });
}
