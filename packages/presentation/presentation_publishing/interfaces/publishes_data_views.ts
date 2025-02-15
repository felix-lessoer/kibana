/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import { DataView } from '@kbn/data-views-plugin/common';
import { PublishingSubject, useStateFromPublishingSubject } from '../publishing_subject';

export interface PublishesDataViews {
  dataViews: PublishingSubject<DataView[] | undefined>;
}

export const apiPublishesDataViews = (
  unknownApi: null | unknown
): unknownApi is PublishesDataViews => {
  return Boolean(unknownApi && (unknownApi as PublishesDataViews)?.dataViews !== undefined);
};

/**
 * Gets this API's data views as a reactive variable which will cause re-renders on change.
 */
export const useDataViews = (api: Partial<PublishesDataViews> | undefined) =>
  useStateFromPublishingSubject(apiPublishesDataViews(api) ? api.dataViews : undefined);
