/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { checkFleetServerVersion, checkKibanaVersion } from './upgrade_handler';

describe('upgrade handler', () => {
  describe('checkKibanaVersion', () => {
    it('should not throw if upgrade version is equal to kibana version', () => {
      expect(() => checkKibanaVersion('8.4.0', '8.4.0')).not.toThrowError();
    });

    it('should throw if upgrade version is higher than kibana version', () => {
      expect(() => checkKibanaVersion('8.5.0', '8.4.0')).toThrowError(
        'Cannot upgrade agent to 8.5.0 because it is higher than the installed kibana version 8.4.0'
      );
    });

    it('should not throw if upgrade version is equal to kibana version with snapshot', () => {
      expect(() => checkKibanaVersion('8.4.0', '8.4.0-SNAPSHOT')).not.toThrowError();
    });

    it('should not throw if force is specified and patch is newer', () => {
      expect(() => checkKibanaVersion('8.4.1', '8.4.0', true)).not.toThrowError();
      expect(() => checkKibanaVersion('8.4.1-SNAPSHOT', '8.4.0', true)).not.toThrowError();
    });

    it('should not throw if not force is specified and patch is newer', () => {
      expect(() => checkKibanaVersion('8.4.1', '8.4.0', false)).not.toThrowError();
      expect(() => checkKibanaVersion('8.4.1-SNAPSHOT', '8.4.0', false)).not.toThrowError();
    });

    it('should throw if force is specified and minor is newer', () => {
      expect(() => checkKibanaVersion('8.5.0', '8.4.0', true)).toThrowError();
    });

    it('should not throw if force is specified and major and minor is newer', () => {
      expect(() => checkKibanaVersion('7.5.0', '8.4.0', true)).not.toThrowError();
      expect(() => checkKibanaVersion('8.4.0', '8.4.0', true)).not.toThrowError();
    });
  });

  describe('checkFleetServerVersion', () => {
    it('should not throw if no force is specified and patch is newer', () => {
      const fleetServers = [
        { local_metadata: { elastic: { agent: { version: '8.3.0' } } } },
        { local_metadata: { elastic: { agent: { version: '8.4.0' } } } },
      ] as any;
      expect(() => checkFleetServerVersion('8.4.1', fleetServers, false)).not.toThrowError();
      expect(() =>
        checkFleetServerVersion('8.4.1-SNAPSHOT', fleetServers, false)
      ).not.toThrowError();
    });

    it('should throw if no force is specified and minor is newer', () => {
      const fleetServers = [
        { local_metadata: { elastic: { agent: { version: '8.3.0' } } } },
        { local_metadata: { elastic: { agent: { version: '8.4.0' } } } },
      ] as any;
      expect(() => checkFleetServerVersion('8.5.1', fleetServers, false)).toThrowError();
    });
  });
});
