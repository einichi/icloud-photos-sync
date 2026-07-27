import mockfs from 'mock-fs';
import {describe, test, jest, expect, afterEach, beforeEach} from '@jest/globals';

import {Asset, AssetType} from '../../src/lib/photos-library/model/asset';
import {FileType} from '../../src/lib/photos-library/model/file-type';
import {Album, AlbumType} from '../../src/lib/photos-library/model/album';
import {fetchAndLoadStateReturnValue, diffStateReturnValue, convertCPLAssetsReturnValue, convertCPLAlbumsReturnValue, loadAssetsReturnValue, loadAlbumsReturnValue, resolveHierarchicalDependenciesReturnValue, fetchAllCPLAssetsMastersReturnValue, fetchAllCPLAlbumsReturnValue, getRandomZone} from '../_helpers/sync-engine.helper';
import {MockedEventManager, MockedNetworkManager, MockedResourceManager, UnknownFunction, prepareResources} from '../_helpers/_general';
import {AxiosError, AxiosResponse} from 'axios';
import {SyncEngineHelper} from '../../src/lib/sync-engine/helper';
import {iCPSEventCloud, iCPSEventRuntimeWarning, iCPSEventSyncEngine} from '../../src/lib/resources/events-types';
import {SyncEngine} from '../../src/lib/sync-engine/sync-engine';
import {iCloud} from '../../src/lib/icloud/icloud';
import {PhotosLibrary} from '../../src/lib/photos-library/photos-library';
import {iCPSError} from '../../src/app/error/error';
import {ICLOUD_PHOTOS_ERR, RESOURCES_ERR, SYNC_ERR} from '../../src/app/error/error-codes';

let mockedResourceManager: MockedResourceManager;
let mockedEventManager: MockedEventManager;
let mockedNetworkManager: MockedNetworkManager;
let syncEngine: SyncEngine;

const testChecksum = (seed: string) => Buffer.from(seed).toString(`base64`);

beforeEach(() => {
    const instances = prepareResources()!;

    mockedResourceManager = instances.manager;
    mockedNetworkManager = instances.network;
    mockedEventManager = instances.event;

    mockfs({});
    syncEngine = new SyncEngine(new iCloud(), new PhotosLibrary());
});

afterEach(() => {
    mockfs.restore();
});

describe(`Coordination`, () => {
    beforeEach(() => {
        mockedNetworkManager.settleRateLimiter = jest.fn<typeof mockedNetworkManager.settleRateLimiter>();
        mockedNetworkManager.settleCCYLimiter = jest.fn<typeof mockedNetworkManager.settleCCYLimiter>();
        syncEngine.icloud.setupAccount = jest.fn<typeof syncEngine.icloud.setupAccount>()
            .mockResolvedValue(true);
        syncEngine.icloud.getReady = jest.fn<typeof syncEngine.icloud.getReady>()
            .mockResolvedValue(true);
        syncEngine.icloud.photos.setup = jest.fn<typeof syncEngine.icloud.photos.setup>()
            .mockResolvedValue();
        (syncEngine as any).getRetryBackoffMs = jest.fn()
            .mockReturnValue(30000);
        (syncEngine as any).waitForRetryBackoff = jest.fn()
            .mockResolvedValue(undefined);
    });

    describe(`Sync`, () => {
        test(`Successful on first try`, async () => {
            const startEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.START);
            syncEngine.fetchAndLoadState = jest.fn<typeof syncEngine.fetchAndLoadState>()
                .mockResolvedValue(fetchAndLoadStateReturnValue);
            syncEngine.diffState = jest.fn<typeof syncEngine.diffState>()
                .mockResolvedValue(diffStateReturnValue);
            syncEngine.writeState = jest.fn<typeof syncEngine.writeState>()
                .mockResolvedValue();
            const doneEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.DONE);
            const retryEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.RETRY);

            await syncEngine.sync();

            expect(startEvent).toHaveBeenCalledTimes(1);
            expect(syncEngine.fetchAndLoadState).toHaveBeenCalledTimes(1);
            expect(syncEngine.diffState).toHaveBeenCalledWith(...fetchAndLoadStateReturnValue);
            expect(syncEngine.writeState).toHaveBeenCalledWith(...diffStateReturnValue);
            expect(doneEvent).toHaveBeenCalledTimes(1);
            expect(mockedNetworkManager.settleRateLimiter).not.toHaveBeenCalled();
            expect(mockedNetworkManager.settleCCYLimiter).not.toHaveBeenCalled();
            expect(retryEvent).not.toHaveBeenCalled();
            expect(syncEngine.icloud.setupAccount).not.toHaveBeenCalled();
            expect(syncEngine.icloud.photos.setup).not.toHaveBeenCalled();
        });

        test(`Reach maximum retries`, async () => {
            mockedResourceManager._resources.maxRetries = 4;

            const startEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.START);
            const retryEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.RETRY);
            syncEngine.fetchAndLoadState = jest.fn<typeof syncEngine.fetchAndLoadState>()
                .mockResolvedValue(fetchAndLoadStateReturnValue);
            syncEngine.diffState = jest.fn<typeof syncEngine.diffState>()
                .mockResolvedValue(diffStateReturnValue);

            const error = new Error(`Bad Request - 421`) as unknown as AxiosError;
            error.name = `AxiosError`;
            error.code = `ERR_BAD_REQUEST`;
            error.response = {
                status: 421,
            } as unknown as AxiosResponse;
            syncEngine.writeState = jest.fn<typeof syncEngine.writeState>()
                .mockRejectedValueOnce(error)
                .mockRejectedValueOnce(error)
                .mockRejectedValueOnce(error)
                .mockRejectedValueOnce(error)
                .mockResolvedValue();

            await expect(syncEngine.sync()).rejects.toEqual(new Error(`Sync did not complete successfully within expected amount of tries`));

            expect(startEvent).toHaveBeenCalled();
            expect(retryEvent).toHaveBeenCalledTimes(3);
            expect(syncEngine.fetchAndLoadState).toHaveBeenCalledTimes(4);
            expect(syncEngine.diffState).toHaveBeenCalledTimes(4);
            expect(syncEngine.diffState).toHaveBeenNthCalledWith(1, ...fetchAndLoadStateReturnValue);
            expect(syncEngine.diffState).toHaveBeenNthCalledWith(2, ...fetchAndLoadStateReturnValue);
            expect(syncEngine.diffState).toHaveBeenNthCalledWith(3, ...fetchAndLoadStateReturnValue);
            expect(syncEngine.diffState).toHaveBeenNthCalledWith(4, ...fetchAndLoadStateReturnValue);
            expect(syncEngine.writeState).toHaveBeenCalledTimes(4);
            expect(syncEngine.writeState).toHaveBeenNthCalledWith(1, ...diffStateReturnValue);
            expect(syncEngine.writeState).toHaveBeenNthCalledWith(2, ...diffStateReturnValue);
            expect(syncEngine.writeState).toHaveBeenNthCalledWith(3, ...diffStateReturnValue);
            expect(syncEngine.writeState).toHaveBeenNthCalledWith(4, ...diffStateReturnValue);
            expect(mockedNetworkManager.settleRateLimiter).toHaveBeenCalledTimes(3);
            expect(mockedNetworkManager.settleCCYLimiter).toHaveBeenCalledTimes(3);
            expect(syncEngine.icloud.setupAccount).toHaveBeenCalledTimes(3);
            expect(syncEngine.icloud.setupAccount).toHaveBeenNthCalledWith(1, {emitSessionExpired: false});
            expect(syncEngine.icloud.setupAccount).toHaveBeenNthCalledWith(2, {emitSessionExpired: false});
            expect(syncEngine.icloud.setupAccount).toHaveBeenNthCalledWith(3, {emitSessionExpired: false});
            expect(syncEngine.icloud.photos.setup).toHaveBeenCalledTimes(3);
            expect((syncEngine as any).waitForRetryBackoff).toHaveBeenCalledTimes(3);
        });

        test.each([
            {
                error: new AxiosError(`Bad Response`, `ERR_BAD_RESPONSE`),
                expectedError: new iCPSError(SYNC_ERR.NETWORK),
                desc: `Network error`,
            }, {
                error: new Error(`Unknown error`),
                expectedError: new iCPSError(SYNC_ERR.UNKNOWN),
                desc: `Unknown error`,
            },
        ])(`Perform retry - $desc`, async ({error, expectedError}) => {
            const startEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.START);
            const retryEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.RETRY);
            syncEngine.fetchAndLoadState = jest.fn<typeof syncEngine.fetchAndLoadState>()
                .mockResolvedValue(fetchAndLoadStateReturnValue);
            syncEngine.diffState = jest.fn<typeof syncEngine.diffState>()
                .mockResolvedValue(diffStateReturnValue);
            syncEngine.writeState = jest.fn<typeof syncEngine.writeState>()
                .mockRejectedValueOnce(error)
                .mockResolvedValueOnce();
            const doneEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.DONE);

            await syncEngine.sync();

            expect(startEvent).toHaveBeenCalled();
            expect(retryEvent).toHaveBeenCalledWith(2, expect.objectContaining({message: expectedError.message}), 30000);
            expect(syncEngine.fetchAndLoadState).toHaveBeenCalledTimes(2);
            expect(syncEngine.diffState).toHaveBeenCalledTimes(2);
            expect(syncEngine.diffState).toHaveBeenNthCalledWith(1, ...fetchAndLoadStateReturnValue);
            expect(syncEngine.diffState).toHaveBeenNthCalledWith(2, ...fetchAndLoadStateReturnValue);
            expect(syncEngine.writeState).toHaveBeenCalledTimes(2);
            expect(syncEngine.writeState).toHaveBeenNthCalledWith(1, ...diffStateReturnValue);
            expect(syncEngine.writeState).toHaveBeenNthCalledWith(2, ...diffStateReturnValue);
            expect(mockedNetworkManager.settleRateLimiter).toHaveBeenCalledTimes(1);
            expect(mockedNetworkManager.settleCCYLimiter).toHaveBeenCalledTimes(1);
            expect(syncEngine.icloud.setupAccount).toHaveBeenCalledTimes(1);
            expect(syncEngine.icloud.setupAccount).toHaveBeenCalledWith({emitSessionExpired: false});
            expect(syncEngine.icloud.photos.setup).toHaveBeenCalledTimes(1);
            expect((syncEngine as any).waitForRetryBackoff).toHaveBeenCalledWith(2, 30000);
            expect(doneEvent).toHaveBeenCalledTimes(1);
        });

        test(`Does not request MFA when refreshing the existing session is rejected during sync retry`, async () => {
            syncEngine.icloud.getReady = jest.fn<typeof syncEngine.icloud.getReady>()
                .mockResolvedValue(true);
            syncEngine.icloud.setupAccount = jest.fn<typeof syncEngine.icloud.setupAccount>()
                .mockResolvedValueOnce(false);

            const error = new Error();

            const startEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.START);
            const retryEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.RETRY);
            const sessionExpiredEvent = mockedEventManager.spyOnEvent(iCPSEventCloud.SESSION_EXPIRED);
            syncEngine.fetchAndLoadState = jest.fn<typeof syncEngine.fetchAndLoadState>()
                .mockResolvedValue(fetchAndLoadStateReturnValue);
            syncEngine.diffState = jest.fn<typeof syncEngine.diffState>()
                .mockResolvedValue(diffStateReturnValue);
            syncEngine.writeState = jest.fn<typeof syncEngine.writeState>()
                .mockRejectedValueOnce(error)
                .mockResolvedValueOnce();
            const doneEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.DONE);

            await syncEngine.sync();

            expect(startEvent).toHaveBeenCalled();
            expect(retryEvent).toHaveBeenCalledWith(2, expect.objectContaining({message: `Unknown error during sync`}), 30000);
            expect(syncEngine.fetchAndLoadState).toHaveBeenCalledTimes(2);
            expect(syncEngine.diffState).toHaveBeenCalledTimes(2);
            expect(syncEngine.diffState).toHaveBeenNthCalledWith(1, ...fetchAndLoadStateReturnValue);
            expect(syncEngine.writeState).toHaveBeenCalledTimes(2);
            expect(syncEngine.writeState).toHaveBeenNthCalledWith(1, ...diffStateReturnValue);
            expect(mockedNetworkManager.settleRateLimiter).toHaveBeenCalledTimes(1);
            expect(mockedNetworkManager.settleCCYLimiter).toHaveBeenCalledTimes(1);
            expect(syncEngine.icloud.setupAccount).toHaveBeenCalledTimes(1);
            expect(syncEngine.icloud.setupAccount).toHaveBeenCalledWith({emitSessionExpired: false});
            expect(sessionExpiredEvent).not.toHaveBeenCalled();
            expect(syncEngine.icloud.getReady).not.toHaveBeenCalled();
            expect(syncEngine.icloud.photos.setup).not.toHaveBeenCalled();
            expect(doneEvent).toHaveBeenCalledTimes(1);
        });

        test(`Continues retrying when refreshing iCloud connection fails`, async () => {
            syncEngine.icloud.getReady = jest.fn<typeof syncEngine.icloud.getReady>()
                .mockRejectedValueOnce(new AxiosError(`Service unavailable`, `ERR_BAD_RESPONSE`, undefined, undefined, {status: 503} as AxiosResponse));

            const error = new AxiosError(`Service unavailable`, `ERR_BAD_RESPONSE`, undefined, undefined, {status: 503} as AxiosResponse);

            const retryEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.RETRY);
            const doneEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.DONE);
            syncEngine.fetchAndLoadState = jest.fn<typeof syncEngine.fetchAndLoadState>()
                .mockResolvedValue(fetchAndLoadStateReturnValue);
            syncEngine.diffState = jest.fn<typeof syncEngine.diffState>()
                .mockResolvedValue(diffStateReturnValue);
            syncEngine.writeState = jest.fn<typeof syncEngine.writeState>()
                .mockRejectedValueOnce(error)
                .mockResolvedValueOnce();

            await syncEngine.sync();

            expect(retryEvent).toHaveBeenCalledWith(2, expect.objectContaining({message: `Network error during sync`}), 30000);
            expect(syncEngine.fetchAndLoadState).toHaveBeenCalledTimes(2);
            expect(syncEngine.diffState).toHaveBeenCalledTimes(2);
            expect(syncEngine.writeState).toHaveBeenCalledTimes(2);
            expect(mockedNetworkManager.settleRateLimiter).toHaveBeenCalledTimes(1);
            expect(mockedNetworkManager.settleCCYLimiter).toHaveBeenCalledTimes(1);
            expect(syncEngine.icloud.setupAccount).toHaveBeenCalledTimes(1);
            expect(syncEngine.icloud.photos.setup).not.toHaveBeenCalled();
            expect(doneEvent).toHaveBeenCalledTimes(1);
        });

        test(`Classifies wrapped Axios errors by root request status`, async () => {
            const error = new iCPSError(ICLOUD_PHOTOS_ERR.FETCH_RECORDS)
                .addCause(new AxiosError(`Service unavailable`, `ERR_BAD_RESPONSE`, undefined, undefined, {status: 503} as AxiosResponse));

            const retryEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.RETRY);
            syncEngine.fetchAndLoadState = jest.fn<typeof syncEngine.fetchAndLoadState>()
                .mockResolvedValue(fetchAndLoadStateReturnValue);
            syncEngine.diffState = jest.fn<typeof syncEngine.diffState>()
                .mockResolvedValue(diffStateReturnValue);
            syncEngine.writeState = jest.fn<typeof syncEngine.writeState>()
                .mockRejectedValueOnce(error)
                .mockResolvedValueOnce();

            await syncEngine.sync();

            expect(retryEvent).toHaveBeenCalledWith(2, expect.objectContaining({message: `Network error during sync`}), 30000);
            expect(mockedNetworkManager.settleRateLimiter).toHaveBeenCalledTimes(1);
            expect(mockedNetworkManager.settleCCYLimiter).toHaveBeenCalledTimes(1);
            expect(syncEngine.icloud.setupAccount).toHaveBeenCalledTimes(1);
            expect(syncEngine.icloud.photos.setup).toHaveBeenCalledTimes(1);
        });

        test(`Does not retry non-retryable request errors`, async () => {
            mockedResourceManager._resources.maxRetries = 4;

            const error = new iCPSError(ICLOUD_PHOTOS_ERR.FETCH_RECORDS)
                .addCause(new AxiosError(`Bad Request`, `ERR_BAD_REQUEST`, undefined, undefined, {status: 400} as AxiosResponse));

            const retryEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.RETRY);
            syncEngine.fetchAndLoadState = jest.fn<typeof syncEngine.fetchAndLoadState>()
                .mockResolvedValue(fetchAndLoadStateReturnValue);
            syncEngine.diffState = jest.fn<typeof syncEngine.diffState>()
                .mockResolvedValue(diffStateReturnValue);
            syncEngine.writeState = jest.fn<typeof syncEngine.writeState>()
                .mockRejectedValue(error);

            await expect(syncEngine.sync()).rejects.toThrow(/^Network error during sync$/);

            expect(retryEvent).not.toHaveBeenCalled();
            expect(syncEngine.fetchAndLoadState).toHaveBeenCalledTimes(1);
            expect(syncEngine.diffState).toHaveBeenCalledTimes(1);
            expect(syncEngine.writeState).toHaveBeenCalledTimes(1);
            expect(mockedNetworkManager.settleRateLimiter).not.toHaveBeenCalled();
            expect(mockedNetworkManager.settleCCYLimiter).not.toHaveBeenCalled();
            expect(syncEngine.icloud.setupAccount).not.toHaveBeenCalled();
            expect(syncEngine.icloud.photos.setup).not.toHaveBeenCalled();
            expect((syncEngine as any).waitForRetryBackoff).not.toHaveBeenCalled();
        });

        test(`Uses retryAfter guidance for backoff`, () => {
            (syncEngine as any).getRetryBackoffMs = (SyncEngine.prototype as any).getRetryBackoffMs;
            const error = new AxiosError(`Service unavailable`, `ERR_BAD_RESPONSE`, undefined, undefined, {
                status: 503,
                data: {
                    retryAfter: 7,
                },
            } as AxiosResponse);

            expect((syncEngine as any).getRetryBackoffMs(2, error)).toBe(7000);
        });
    });

    test(`Fetch & Load State`, async () => {
        const fetchNLoadEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.FETCH_N_LOAD);
        const fetchNLoadProgressEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.FETCH_N_LOAD_PROGRESS);

        const convertCPLAlbumsOriginal = SyncEngineHelper.convertCPLAlbums;
        const convertCPLAssetsOriginal = SyncEngineHelper.convertCPLAssets;

        syncEngine.icloud.photos.fetchAllCPLAssetsMasters = jest.fn<typeof syncEngine.icloud.photos.fetchAllCPLAssetsMasters>()
            .mockResolvedValue(fetchAllCPLAssetsMastersReturnValue);
        SyncEngineHelper.convertCPLAssets = jest.fn<typeof SyncEngineHelper.convertCPLAssets>()
            .mockReturnValue(convertCPLAssetsReturnValue);

        syncEngine.icloud.photos.fetchAllCPLAlbums = jest.fn<typeof syncEngine.icloud.photos.fetchAllCPLAlbums>()
            .mockResolvedValue(fetchAllCPLAlbumsReturnValue);
        SyncEngineHelper.convertCPLAlbums = jest.fn<typeof SyncEngineHelper.convertCPLAlbums>()
            .mockReturnValue(convertCPLAlbumsReturnValue);

        syncEngine.photosLibrary.loadAssets = jest.fn<typeof syncEngine.photosLibrary.loadAssets>()
            .mockResolvedValue(loadAssetsReturnValue);

        syncEngine.photosLibrary.loadAlbums = jest.fn<typeof syncEngine.photosLibrary.loadAlbums>()
            .mockResolvedValue(loadAlbumsReturnValue);

        const fetchNLoadCompletedEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.FETCH_N_LOAD_COMPLETED);

        const result = await syncEngine.fetchAndLoadState();

        expect(fetchNLoadEvent).toHaveBeenCalledTimes(1);
        expect(fetchNLoadProgressEvent).toHaveBeenCalledWith(`Loading local assets and albums from disk; fetching remote asset metadata...`, 16);
        expect(fetchNLoadProgressEvent).toHaveBeenCalledWith(`Fetched remote asset metadata (1 assets, 1 masters); converting...`, 20);
        expect(fetchNLoadProgressEvent).toHaveBeenCalledWith(`Converted 1 remote assets; fetching remote album metadata...`, 21);
        expect(fetchNLoadProgressEvent).toHaveBeenCalledWith(`Fetched remote album metadata (1 records); converting...`, 22);
        expect(fetchNLoadProgressEvent).toHaveBeenCalledWith(`Waiting for local library state from disk...`, 22);
        expect(fetchNLoadProgressEvent).toHaveBeenCalledWith(`Loaded local library state (1 assets, 1 albums)`, 23);
        expect(syncEngine.icloud.photos.fetchAllCPLAssetsMasters).toHaveBeenCalledTimes(1);
        expect(SyncEngineHelper.convertCPLAssets).toHaveBeenCalledTimes(1);
        expect(SyncEngineHelper.convertCPLAssets).toHaveBeenCalledWith(...fetchAllCPLAssetsMastersReturnValue);
        expect(syncEngine.icloud.photos.fetchAllCPLAlbums).toHaveBeenCalledTimes(1);
        expect(SyncEngineHelper.convertCPLAlbums).toHaveBeenCalledTimes(1);
        expect(SyncEngineHelper.convertCPLAlbums).toHaveBeenCalledWith(fetchAllCPLAlbumsReturnValue);
        expect(syncEngine.photosLibrary.loadAssets).toHaveBeenCalledTimes(1);
        expect(syncEngine.photosLibrary.loadAlbums).toHaveBeenCalledTimes(1);
        expect(fetchNLoadCompletedEvent).toHaveBeenCalledTimes(1);
        expect(fetchNLoadCompletedEvent).toHaveBeenCalledWith(1, 1, 1, 1);
        expect(result).toEqual([convertCPLAssetsReturnValue, convertCPLAlbumsReturnValue, loadAssetsReturnValue, loadAlbumsReturnValue]);

        SyncEngineHelper.convertCPLAlbums = convertCPLAlbumsOriginal;
        SyncEngineHelper.convertCPLAssets = convertCPLAssetsOriginal;
    });

    test(`Diff state`, async () => {
        const getProcessingQueuesOriginal = SyncEngineHelper.getProcessingQueues;
        const resolveHierarchicalDependenciesOriginal = SyncEngineHelper.resolveHierarchicalDependencies;

        const diffStartEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.DIFF);
        SyncEngineHelper.getProcessingQueues = jest.fn<typeof SyncEngineHelper.getProcessingQueues<any>>()
            .mockReturnValue([[], [], []]);
        SyncEngineHelper.resolveHierarchicalDependencies = jest.fn<typeof SyncEngineHelper.resolveHierarchicalDependencies>()
            .mockReturnValue(resolveHierarchicalDependenciesReturnValue);
        const diffCompletedEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.DIFF_COMPLETED);

        const result = await syncEngine.diffState(...fetchAndLoadStateReturnValue);

        expect(diffStartEvent).toHaveBeenCalledTimes(1);
        expect(SyncEngineHelper.getProcessingQueues).toHaveBeenCalledTimes(2);
        expect(SyncEngineHelper.getProcessingQueues).toHaveBeenNthCalledWith(1, fetchAndLoadStateReturnValue[0], fetchAndLoadStateReturnValue[2]);
        expect(SyncEngineHelper.getProcessingQueues).toHaveBeenNthCalledWith(2, fetchAndLoadStateReturnValue[1], fetchAndLoadStateReturnValue[3]);
        expect(SyncEngineHelper.resolveHierarchicalDependencies).toHaveBeenCalledTimes(1);
        expect(diffCompletedEvent).toHaveBeenCalledTimes(1);
        expect(result).toEqual([[[], [], []], resolveHierarchicalDependenciesReturnValue]);

        SyncEngineHelper.getProcessingQueues = getProcessingQueuesOriginal;
        SyncEngineHelper.resolveHierarchicalDependencies = resolveHierarchicalDependenciesOriginal;
    });

    test(`Write state`, async () => {
        syncEngine.writeAssets = jest.fn<typeof syncEngine.writeAssets>()
            .mockResolvedValue();
        syncEngine.writeAlbums = jest.fn<typeof syncEngine.writeAlbums>()
            .mockResolvedValue();

        const writeEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.WRITE);
        const writeAssetsEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.WRITE_ASSETS);
        const writeAssetsCompletedEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.WRITE_ASSETS_COMPLETED);
        const writeAlbumsEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.WRITE_ALBUMS);
        const writeAlbumCompletedEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.WRITE_ALBUMS_COMPLETED);
        const writeCompletedEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.WRITE_COMPLETED);

        await syncEngine.writeState(...diffStateReturnValue);

        expect(writeEvent).toHaveBeenCalledTimes(1);
        expect(syncEngine.writeAssets).toHaveBeenCalledTimes(1);
        expect(syncEngine.writeAssets).toHaveBeenCalledWith(diffStateReturnValue[0]);
        expect(writeAssetsEvent).not.toHaveBeenCalled();
        expect(writeAssetsCompletedEvent).toHaveBeenCalledTimes(1);
        expect(writeAlbumsEvent).toHaveBeenCalledTimes(1);
        expect(writeAlbumsEvent).toHaveBeenCalledWith(1, 1, 1);
        expect(syncEngine.writeAlbums).toHaveBeenCalledTimes(1);
        expect(syncEngine.writeAlbums).toHaveBeenCalledWith(diffStateReturnValue[1]);
        expect(writeAlbumCompletedEvent).toHaveBeenCalledTimes(1);
        expect(writeCompletedEvent).toHaveBeenCalledTimes(1);
    });
});

describe(`Handle processing queue`, () => {
    describe(`Handle asset queue`, () => {
        let writeAssetCompleteEvent: jest.Mock<UnknownFunction>;
        let writeAssetDownloadedEvent: jest.Mock<UnknownFunction>;
        let writeAssetErrorEvent: jest.Mock<UnknownFunction>;
        let writeAssetsEvent: jest.Mock<UnknownFunction>;
        let writeAssetStartedEvent: jest.Mock<UnknownFunction>;
        let verifyLocalAssetsProgressEvent: jest.Mock<UnknownFunction>;

        beforeEach(() => {
            syncEngine.photosLibrary.deleteAsset = jest.fn<typeof syncEngine.photosLibrary.deleteAsset>()
                .mockResolvedValue();
            syncEngine.icloud.photos.downloadAsset = jest.fn<typeof syncEngine.icloud.photos.downloadAsset>()
                .mockResolvedValue();

            writeAssetCompleteEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.WRITE_ASSET_COMPLETED);
            writeAssetDownloadedEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.WRITE_ASSET_DOWNLOADED);
            writeAssetErrorEvent = mockedEventManager.spyOnEvent(iCPSEventRuntimeWarning.WRITE_ASSET_ERROR);
            writeAssetsEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.WRITE_ASSETS);
            writeAssetStartedEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.WRITE_ASSET_STARTED);
            verifyLocalAssetsProgressEvent = mockedEventManager.spyOnEvent(iCPSEventSyncEngine.VERIFY_LOCAL_ASSETS_PROGRESS);
        });

        test(`Empty processing queue`, async () => {
            await syncEngine.writeAssets([[], [], []]);

            expect(syncEngine.photosLibrary.deleteAsset).not.toHaveBeenCalled();
            expect(syncEngine.icloud.photos.downloadAsset).not.toHaveBeenCalled();
            expect(writeAssetCompleteEvent).not.toHaveBeenCalled();
        });

        test(`Only deleting`, async () => {
            const asset1 = new Asset(testChecksum(`asset1`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test1`, `somekey`, testChecksum(`asset1`), `https://icloud.com`, `somerecordname1`, false);
            const asset2 = new Asset(testChecksum(`asset2`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test2`, `somekey`, testChecksum(`asset2`), `https://icloud.com`, `somerecordname2`, false);
            const asset3 = new Asset(testChecksum(`asset3`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.ORIG, `test3`, `somekey`, testChecksum(`asset3`), `https://icloud.com`, `somerecordname3`, false);
            const toBeDeleted = [asset1, asset2, asset3];

            await syncEngine.writeAssets([toBeDeleted, [], []]);

            expect(syncEngine.photosLibrary.deleteAsset).toHaveBeenCalledTimes(3);
            expect(syncEngine.photosLibrary.deleteAsset).toHaveBeenNthCalledWith(1, asset1);
            expect(syncEngine.photosLibrary.deleteAsset).toHaveBeenNthCalledWith(2, asset2);
            expect(syncEngine.photosLibrary.deleteAsset).toHaveBeenNthCalledWith(3, asset3);
            expect(syncEngine.icloud.photos.downloadAsset).not.toHaveBeenCalled();
            expect(writeAssetCompleteEvent).not.toHaveBeenCalled();
        });

        test(`Only keeping verifies local assets`, async () => {
            const asset1 = new Asset(testChecksum(`asset1`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test1`, `somekey`, testChecksum(`asset1`), `https://icloud.com`, `somerecordname1`, false);
            asset1.verify = jest.fn<typeof asset1.verify>()
                .mockResolvedValue(true);
            const asset2 = new Asset(testChecksum(`asset2`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test2`, `somekey`, testChecksum(`asset2`), `https://icloud.com`, `somerecordname2`, false);
            asset2.verify = jest.fn<typeof asset2.verify>()
                .mockResolvedValue(true);

            await syncEngine.writeAssets([[], [], [asset1, asset2]]);

            expect(asset1.verify).toHaveBeenCalledTimes(1);
            expect(asset2.verify).toHaveBeenCalledTimes(1);
            expect(verifyLocalAssetsProgressEvent).toHaveBeenCalledTimes(3);
            expect(verifyLocalAssetsProgressEvent).toHaveBeenNthCalledWith(1, 0, 2, `test1-edited.png`);
            expect(verifyLocalAssetsProgressEvent).toHaveBeenNthCalledWith(2, 1, 2, `test2-edited.png`);
            expect(verifyLocalAssetsProgressEvent).toHaveBeenNthCalledWith(3, 2, 2);
            expect(syncEngine.photosLibrary.deleteAsset).not.toHaveBeenCalled();
            expect(syncEngine.icloud.photos.downloadAsset).not.toHaveBeenCalled();
            expect(writeAssetCompleteEvent).not.toHaveBeenCalled();
            expect(writeAssetErrorEvent).not.toHaveBeenCalled();
        });

        test(`Can skip checksum verification for kept local assets`, async () => {
            syncEngine = new SyncEngine(new iCloud(), new PhotosLibrary(), {verifyKeptAssetChecksums: false});
            syncEngine.photosLibrary.deleteAsset = jest.fn<typeof syncEngine.photosLibrary.deleteAsset>()
                .mockResolvedValue();
            syncEngine.icloud.photos.downloadAsset = jest.fn<typeof syncEngine.icloud.photos.downloadAsset>()
                .mockResolvedValue();
            const asset = new Asset(testChecksum(`asset1`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test1`, `somekey`, testChecksum(`asset1`), `https://icloud.com`, `somerecordname1`, false);
            asset.verify = jest.fn<typeof asset.verify>()
                .mockRejectedValue(new Error(`checksum error`));

            await syncEngine.writeAssets([[], [], [asset]]);

            expect(asset.verify).not.toHaveBeenCalled();
            expect(verifyLocalAssetsProgressEvent).not.toHaveBeenCalled();
            expect(syncEngine.photosLibrary.deleteAsset).not.toHaveBeenCalled();
            expect(syncEngine.icloud.photos.downloadAsset).not.toHaveBeenCalled();
            expect(writeAssetsEvent).toHaveBeenCalledTimes(1);
            expect(writeAssetsEvent).toHaveBeenCalledWith(0, 0, 1);
            expect(writeAssetStartedEvent).not.toHaveBeenCalled();
            expect(writeAssetCompleteEvent).not.toHaveBeenCalled();
            expect(writeAssetErrorEvent).not.toHaveBeenCalled();
        });

        test(`Redownloads kept asset that fails verification`, async () => {
            const asset = new Asset(testChecksum(`asset1`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test1`, `somekey`, testChecksum(`asset1`), `https://icloud.com`, `somerecordname1`, false);
            // A kept asset exists on disk; it fails verification during the kept-asset check and again before redownloading
            mockfs({[asset.getAssetFilePath()]: `corrupted`});
            asset.verify = jest.fn<typeof asset.verify>()
                .mockRejectedValueOnce(new Error(`checksum error`))
                .mockRejectedValueOnce(new Error(`checksum error`))
                .mockResolvedValueOnce(true);

            await syncEngine.writeAssets([[], [], [asset]]);

            expect(verifyLocalAssetsProgressEvent).toHaveBeenCalledTimes(2);
            expect(verifyLocalAssetsProgressEvent).toHaveBeenNthCalledWith(1, 0, 1, `test1-edited.png`);
            expect(verifyLocalAssetsProgressEvent).toHaveBeenNthCalledWith(2, 1, 1);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenCalledTimes(1);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenCalledWith(asset);
            expect(writeAssetsEvent).toHaveBeenCalledTimes(1);
            expect(writeAssetsEvent).toHaveBeenCalledWith(0, 1, 0);
            expect(writeAssetStartedEvent).toHaveBeenCalledTimes(1);
            expect(writeAssetStartedEvent).toHaveBeenCalledWith(`test1-edited.png`);
            expect(writeAssetDownloadedEvent).toHaveBeenCalledTimes(1);
            expect(writeAssetDownloadedEvent).toHaveBeenCalledWith(`test1-edited.png`, `redownloaded`);
            expect(writeAssetCompleteEvent).toHaveBeenCalledTimes(1);
            expect(writeAssetCompleteEvent).toHaveBeenCalledWith(`test1-edited.png`);
            expect(writeAssetErrorEvent).not.toHaveBeenCalled();
        });

        test(`Reports a replaced existing asset as redownloaded, even without checksum verification`, async () => {
            // The asset comes through the diff as an add (e.g. size/modification-time mismatch), not via kept-asset
            // checksum verification, but a stale local file is still present and gets replaced - so it is a redownload.
            const asset = new Asset(testChecksum(`asset1`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test1`, `somekey`, testChecksum(`asset1`), `https://icloud.com`, `somerecordname1`, false);
            mockfs({[asset.getAssetFilePath()]: `stale`});
            asset.verify = jest.fn<typeof asset.verify>()
                .mockRejectedValueOnce(new Error(`size mismatch`))
                .mockResolvedValueOnce(true);

            await syncEngine.writeAssets([[], [asset], []]);

            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenCalledTimes(1);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenCalledWith(asset);
            expect(writeAssetDownloadedEvent).toHaveBeenCalledTimes(1);
            expect(writeAssetDownloadedEvent).toHaveBeenCalledWith(`test1-edited.png`, `redownloaded`);
            expect(writeAssetErrorEvent).not.toHaveBeenCalled();
        });

        test(`Only adding`, async () => {
            const asset1 = new Asset(testChecksum(`asset1`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test1`, `somekey`, testChecksum(`asset1`), `https://icloud.com`, `somerecordname1`, false);
            asset1.verify = jest.fn<typeof asset1.verify>();
            const asset2 = new Asset(testChecksum(`asset2`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test2`, `somekey`, testChecksum(`asset2`), `https://icloud.com`, `somerecordname2`, false);
            asset2.verify = jest.fn<typeof asset2.verify>();
            const asset3 = new Asset(testChecksum(`asset3`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.ORIG, `test3`, `somekey`, testChecksum(`asset3`), `https://icloud.com`, `somerecordname3`, false);
            asset3.verify = jest.fn<typeof asset3.verify>();
            const toBeAdded = [asset1, asset2, asset3];

            await syncEngine.writeAssets([[], toBeAdded, []]);

            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenCalledTimes(3);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenNthCalledWith(1, asset1);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenNthCalledWith(2, asset2);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenNthCalledWith(3, asset3);

            expect(writeAssetCompleteEvent).toHaveBeenCalledTimes(3);
            expect(writeAssetCompleteEvent).toHaveBeenNthCalledWith(1, `test1-edited.png`);
            expect(writeAssetCompleteEvent).toHaveBeenNthCalledWith(2, `test2-edited.png`);
            expect(writeAssetCompleteEvent).toHaveBeenNthCalledWith(3, `test3.png`);
            expect(writeAssetDownloadedEvent).toHaveBeenCalledTimes(3);
            expect(writeAssetDownloadedEvent).toHaveBeenNthCalledWith(1, `test1-edited.png`, `new`);
            expect(writeAssetDownloadedEvent).toHaveBeenNthCalledWith(2, `test2-edited.png`, `new`);
            expect(writeAssetDownloadedEvent).toHaveBeenNthCalledWith(3, `test3.png`, `new`);

            expect(writeAssetErrorEvent).not.toHaveBeenCalled();

            expect(syncEngine.photosLibrary.deleteAsset).not.toHaveBeenCalled();
        });

        test(`Only adding with verification error`, async () => {
            const asset1 = new Asset(testChecksum(`asset1`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test1`, `somekey`, testChecksum(`asset1`), `https://icloud.com`, `somerecordname1`, false);
            asset1.verify = jest.fn<typeof asset1.verify>();
            const asset2 = new Asset(testChecksum(`asset2`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test2`, `somekey`, testChecksum(`asset2`), `https://icloud.com`, `somerecordname2`, false);
            asset2.verify = jest.fn<typeof asset2.verify>();
            const asset3 = new Asset(testChecksum(`asset3`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.ORIG, `test3`, `somekey`, testChecksum(`asset3`), `https://icloud.com`, `somerecordname3`, false);
            asset3.verify = jest.fn<typeof asset3.verify>()
                .mockRejectedValue(new Error(`verification error`));

            const toBeAdded = [asset1, asset2, asset3];

            await expect(syncEngine.writeAssets([[], toBeAdded, []])).rejects.toMatchObject({
                code: SYNC_ERR.WRITE_ASSETS.code,
                messages: [`1 asset(s) were not copied`],
            });

            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenCalledTimes(3);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenNthCalledWith(1, asset1);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenNthCalledWith(2, asset2);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenNthCalledWith(3, asset3);

            expect(writeAssetErrorEvent).toHaveBeenCalledTimes(1);

            expect(writeAssetCompleteEvent).toHaveBeenCalledTimes(2);
            expect(writeAssetCompleteEvent).toHaveBeenNthCalledWith(1, `test1-edited.png`);
            expect(writeAssetCompleteEvent).toHaveBeenNthCalledWith(2, `test2-edited.png`);

            expect(syncEngine.photosLibrary.deleteAsset).toHaveBeenCalledTimes(1);
            expect(syncEngine.photosLibrary.deleteAsset).toHaveBeenCalledWith(asset3);
        });

        test(`Only adding with download errors attempts every asset before failing`, async () => {
            mockedResourceManager._resources.downloadThreads = 1;
            const asset1 = new Asset(testChecksum(`asset1`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test1`, `somekey`, testChecksum(`asset1`), `https://icloud.com`, `somerecordname1`, false);
            asset1.verify = jest.fn<typeof asset1.verify>();
            const asset2 = new Asset(testChecksum(`asset2`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test2`, `somekey`, testChecksum(`asset2`), `https://icloud.com`, `somerecordname2`, false);
            asset2.verify = jest.fn<typeof asset2.verify>();
            const asset3 = new Asset(testChecksum(`asset3`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.ORIG, `test3`, `somekey`, testChecksum(`asset3`), `https://icloud.com`, `somerecordname3`, false);
            asset3.verify = jest.fn<typeof asset3.verify>();

            const downloadError = new Error(`download error`);
            const secondDownloadError = new Error(`second download error`);
            syncEngine.icloud.photos.downloadAsset = jest.fn<typeof syncEngine.icloud.photos.downloadAsset>()
                .mockResolvedValueOnce()
                .mockRejectedValueOnce(downloadError)
                .mockRejectedValueOnce(secondDownloadError);

            const toBeAdded = [asset1, asset2, asset3];

            await expect(syncEngine.writeAssets([[], toBeAdded, []])).rejects.toMatchObject({
                code: SYNC_ERR.WRITE_ASSETS.code,
                messages: [`2 asset(s) were not copied`],
                context: {
                    failedAssetWrites: expect.arrayContaining([
                        expect.objectContaining({
                            assetName: `test2-edited.png`,
                            reason: expect.stringContaining(`download error`),
                        }),
                        expect.objectContaining({
                            assetName: `test3.png`,
                            reason: expect.stringContaining(`second download error`),
                        }),
                    ]),
                },
            });

            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenCalledTimes(3);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenNthCalledWith(1, asset1);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenNthCalledWith(2, asset2);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenNthCalledWith(3, asset3);

            expect(writeAssetCompleteEvent).toHaveBeenCalledTimes(1);
            expect(writeAssetCompleteEvent).toHaveBeenNthCalledWith(1, `test1-edited.png`);
            expect(writeAssetErrorEvent).toHaveBeenCalledTimes(2);
            expect(writeAssetErrorEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
                cause: downloadError,
                code: `UNKNOWN`,
            }), asset2);
            expect(writeAssetErrorEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
                cause: secondDownloadError,
                code: `UNKNOWN`,
            }), asset3);

            expect(syncEngine.photosLibrary.deleteAsset).toHaveBeenCalledTimes(2);
            expect(syncEngine.photosLibrary.deleteAsset).toHaveBeenNthCalledWith(1, asset2);
            expect(syncEngine.photosLibrary.deleteAsset).toHaveBeenNthCalledWith(2, asset3);
        });

        test(`Retries transient asset download timeout before reporting an error`, async () => {
            const asset = new Asset(testChecksum(`asset1`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.ORIG, `test1`, `somekey`, testChecksum(`asset1`), `https://icloud.com`, `somerecordname1`, false);
            asset.verify = jest.fn<typeof asset.verify>()
                .mockResolvedValue(true);
            const downloadTimeout = new iCPSError(RESOURCES_ERR.DOWNLOAD_TIMEOUT)
                .addMessage(`timed out`);
            syncEngine.icloud.photos.downloadAsset = jest.fn<typeof syncEngine.icloud.photos.downloadAsset>()
                .mockRejectedValueOnce(downloadTimeout)
                .mockResolvedValueOnce();

            await syncEngine.writeAssets([[], [asset], []]);

            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenCalledTimes(2);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenNthCalledWith(1, asset);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenNthCalledWith(2, asset);
            expect(syncEngine.photosLibrary.deleteAsset).toHaveBeenCalledTimes(1);
            expect(syncEngine.photosLibrary.deleteAsset).toHaveBeenCalledWith(asset);
            expect(writeAssetStartedEvent).toHaveBeenCalledTimes(1);
            expect(writeAssetCompleteEvent).toHaveBeenCalledTimes(1);
            expect(writeAssetCompleteEvent).toHaveBeenCalledWith(`test1.png`);
            expect(writeAssetDownloadedEvent).toHaveBeenCalledTimes(1);
            expect(writeAssetDownloadedEvent).toHaveBeenCalledWith(`test1.png`, `new`);
            expect(writeAssetErrorEvent).not.toHaveBeenCalled();
        });

        test(`Adding & deleting`, async () => {
            const asset1 = new Asset(testChecksum(`asset1`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test1`, `somekey`, testChecksum(`asset1`), `https://icloud.com`, `somerecordname1`, false);
            asset1.verify = jest.fn<typeof asset1.verify>();
            const asset2 = new Asset(testChecksum(`asset2`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test2`, `somekey`, testChecksum(`asset2`), `https://icloud.com`, `somerecordname2`, false);
            asset2.verify = jest.fn<typeof asset2.verify>();
            const asset3 = new Asset(testChecksum(`asset3`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.ORIG, `test3`, `somekey`, testChecksum(`asset3`), `https://icloud.com`, `somerecordname3`, false);
            asset3.verify = jest.fn<typeof asset3.verify>();
            const asset4 = new Asset(testChecksum(`asset4`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test4`, `somekey`, testChecksum(`asset4`), `https://icloud.com`, `somerecordname4`, false);
            const asset5 = new Asset(testChecksum(`asset5`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.EDIT, `test5`, `somekey`, testChecksum(`asset5`), `https://icloud.com`, `somerecordname5`, false);
            const asset6 = new Asset(testChecksum(`asset6`), 42, FileType.fromExtension(`png`), 42, getRandomZone(), AssetType.ORIG, `test6`, `somekey`, testChecksum(`asset6`), `https://icloud.com`, `somerecordname6`, false);
            const toBeAdded = [asset1, asset2, asset3];
            const toBeDeleted = [asset4, asset5, asset6];

            await syncEngine.writeAssets([toBeDeleted, toBeAdded, []]);

            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenCalledTimes(3);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenNthCalledWith(1, asset1);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenNthCalledWith(2, asset2);
            expect(syncEngine.icloud.photos.downloadAsset).toHaveBeenNthCalledWith(3, asset3);

            expect(writeAssetCompleteEvent).toHaveBeenCalledTimes(3);
            expect(writeAssetCompleteEvent).toHaveBeenNthCalledWith(1, `test1-edited.png`);
            expect(writeAssetCompleteEvent).toHaveBeenNthCalledWith(2, `test2-edited.png`);
            expect(writeAssetCompleteEvent).toHaveBeenNthCalledWith(3, `test3.png`);

            expect(syncEngine.photosLibrary.deleteAsset).toHaveBeenCalledTimes(3);
            expect(syncEngine.photosLibrary.deleteAsset).toHaveBeenNthCalledWith(1, asset4);
            expect(syncEngine.photosLibrary.deleteAsset).toHaveBeenNthCalledWith(2, asset5);
            expect(syncEngine.photosLibrary.deleteAsset).toHaveBeenNthCalledWith(3, asset6);
        });
    });

    describe(`Handle album queue`, () => {
        beforeEach(() => {
            syncEngine.photosLibrary.cleanArchivedOrphans = jest.fn<typeof syncEngine.photosLibrary.cleanArchivedOrphans>()
                .mockResolvedValue();
            syncEngine.photosLibrary.stashArchivedAlbum = jest.fn<typeof syncEngine.photosLibrary.stashArchivedAlbum>()
                .mockReturnValue({} as any);
            syncEngine.photosLibrary.retrieveStashedAlbum = jest.fn<typeof syncEngine.photosLibrary.retrieveStashedAlbum>()
                .mockReturnValue({} as any);
            syncEngine.photosLibrary.writeAlbum = jest.fn<typeof syncEngine.photosLibrary.writeAlbum>()
                .mockReturnValue();
            syncEngine.photosLibrary.deleteAlbum = jest.fn<typeof syncEngine.photosLibrary.deleteAlbum>()
                .mockReturnValue();
        });

        test(`Empty processing queue`, async () => {
            await syncEngine.writeAlbums([[], [], []]);

            expect(syncEngine.photosLibrary.cleanArchivedOrphans).toHaveBeenCalled();
            expect(syncEngine.photosLibrary.stashArchivedAlbum).not.toHaveBeenCalled();
            expect(syncEngine.photosLibrary.retrieveStashedAlbum).not.toHaveBeenCalled();
            expect(syncEngine.photosLibrary.writeAlbum).not.toHaveBeenCalled();
            expect(syncEngine.photosLibrary.deleteAlbum).not.toHaveBeenCalled();
        });

        test(`Only deleting`, async () => {
            const albumParent = new Album(`someUUID1`, AlbumType.ALBUM, `someAlbumName1`, ``);
            const albumChild = new Album(`someUUID1-1`, AlbumType.ALBUM, `someAlbumName2`, `someUUID1`);
            const albumChildChild = new Album(`someUUID1-1-1`, AlbumType.ALBUM, `someAlbumName3`, `someUUID1-1`);
            // The order here does not matter
            await syncEngine.writeAlbums([[albumChild, albumChildChild, albumParent], [], []]);

            expect(syncEngine.photosLibrary.cleanArchivedOrphans).toHaveBeenCalled();
            expect(syncEngine.photosLibrary.stashArchivedAlbum).not.toHaveBeenCalled();
            expect(syncEngine.photosLibrary.retrieveStashedAlbum).not.toHaveBeenCalled();
            expect(syncEngine.photosLibrary.writeAlbum).not.toHaveBeenCalled();
            expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenCalledTimes(3);
            // Needs to be called from the furthest node
            expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenNthCalledWith(1, albumChildChild);
            expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenNthCalledWith(2, albumChild);
            expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenNthCalledWith(3, albumParent);
        });

        test(`Only adding`, async () => {
            const albumParent = new Album(`someUUID1`, AlbumType.ALBUM, `someAlbumName1`, ``);
            const albumChild = new Album(`someUUID1-1`, AlbumType.ALBUM, `someAlbumName2`, `someUUID1`);
            const albumChildChild = new Album(`someUUID1-1-1`, AlbumType.ALBUM, `someAlbumName3`, `someUUID1-1`);
            // The order here does not matter
            await syncEngine.writeAlbums([[], [albumChild, albumChildChild, albumParent], []]);

            expect(syncEngine.photosLibrary.cleanArchivedOrphans).toHaveBeenCalled();
            expect(syncEngine.photosLibrary.stashArchivedAlbum).not.toHaveBeenCalled();
            expect(syncEngine.photosLibrary.retrieveStashedAlbum).not.toHaveBeenCalled();
            expect(syncEngine.photosLibrary.deleteAlbum).not.toHaveBeenCalled();
            expect(syncEngine.photosLibrary.writeAlbum).toHaveBeenCalledTimes(3);
            // Needs to be called from the furthest node
            expect(syncEngine.photosLibrary.writeAlbum).toHaveBeenNthCalledWith(1, albumParent);
            expect(syncEngine.photosLibrary.writeAlbum).toHaveBeenNthCalledWith(2, albumChild);
            expect(syncEngine.photosLibrary.writeAlbum).toHaveBeenNthCalledWith(3, albumChildChild);
        });

        test(`Adding & deleting`, async () => {
            const addAlbumParent = new Album(`someUUID1`, AlbumType.ALBUM, `someAlbumName1`, ``);
            const addAlbumChild = new Album(`someUUID1-1`, AlbumType.ALBUM, `someAlbumName2`, `someUUID1`);
            const addAlbumChildChild = new Album(`someUUID1-1-1`, AlbumType.ALBUM, `someAlbumName3`, `someUUID1-1`);
            const removeAlbumParent = new Album(`someUUID2`, AlbumType.ALBUM, `someAlbumName4`, ``);
            const removeAlbumChild = new Album(`someUUID2-1`, AlbumType.ALBUM, `someAlbumName5`, `someUUID2`);
            const removeAlbumChildChild = new Album(`someUUID2-1-1`, AlbumType.ALBUM, `someAlbumName6`, `someUUID2-1`);
            // The order here does not matter
            await syncEngine.writeAlbums([[removeAlbumChild, removeAlbumParent, removeAlbumChildChild], [addAlbumChild, addAlbumParent, addAlbumChildChild], []]);

            expect(syncEngine.photosLibrary.cleanArchivedOrphans).toHaveBeenCalled();
            expect(syncEngine.photosLibrary.stashArchivedAlbum).not.toHaveBeenCalled();
            expect(syncEngine.photosLibrary.retrieveStashedAlbum).not.toHaveBeenCalled();

            expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenCalledTimes(3);
            // Needs to be called from the furthest node
            expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenNthCalledWith(1, removeAlbumChildChild);
            expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenNthCalledWith(2, removeAlbumChild);
            expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenNthCalledWith(3, removeAlbumParent);

            expect(syncEngine.photosLibrary.writeAlbum).toHaveBeenCalledTimes(3);
            // Needs to be called from the closest node
            expect(syncEngine.photosLibrary.writeAlbum).toHaveBeenNthCalledWith(1, addAlbumParent);
            expect(syncEngine.photosLibrary.writeAlbum).toHaveBeenNthCalledWith(2, addAlbumChild);
            expect(syncEngine.photosLibrary.writeAlbum).toHaveBeenNthCalledWith(3, addAlbumChildChild);
        });

        test(`Adding - Warning fired on error`, async () => {
            const warnEvent = mockedEventManager.spyOnEvent(iCPSEventRuntimeWarning.WRITE_ALBUM_ERROR);

            const addAlbumParent = new Album(`someUUID1`, AlbumType.ALBUM, `someAlbumName1`, ``);
            const addAlbumChild = new Album(`someUUID1-1`, AlbumType.ALBUM, `someAlbumName2`, `someUUID1`);
            const addAlbumChildChild = new Album(`someUUID1-1-1`, AlbumType.ALBUM, `someAlbumName3`, `someUUID1-1`);

            syncEngine.photosLibrary.writeAlbum = jest.fn<typeof syncEngine.photosLibrary.writeAlbum>()
                .mockImplementationOnce(() => {
                    throw new Error(`Unable to write album`);
                });

            // The order here does not matter
            await syncEngine.writeAlbums([[], [addAlbumChild, addAlbumParent, addAlbumChildChild], []]);

            expect(syncEngine.photosLibrary.cleanArchivedOrphans).toHaveBeenCalled();
            expect(syncEngine.photosLibrary.stashArchivedAlbum).not.toHaveBeenCalled();
            expect(syncEngine.photosLibrary.retrieveStashedAlbum).not.toHaveBeenCalled();

            expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenCalledTimes(0);

            expect(syncEngine.photosLibrary.writeAlbum).toHaveBeenCalledTimes(3);
            // Needs to be called from the closest node
            expect(syncEngine.photosLibrary.writeAlbum).toHaveBeenNthCalledWith(1, addAlbumParent);
            expect(syncEngine.photosLibrary.writeAlbum).toHaveBeenNthCalledWith(2, addAlbumChild);
            expect(syncEngine.photosLibrary.writeAlbum).toHaveBeenNthCalledWith(3, addAlbumChildChild);

            expect(warnEvent).toHaveBeenCalled();
        });

        test(`Deleting - HANDLER_EVENT fired on error`, async () => {
            const warnEvent = mockedEventManager.spyOnEvent(iCPSEventRuntimeWarning.WRITE_ALBUM_ERROR);

            const removeAlbumParent = new Album(`someUUID2`, AlbumType.ALBUM, `someAlbumName4`, ``);
            const removeAlbumChild = new Album(`someUUID2-1`, AlbumType.ALBUM, `someAlbumName5`, `someUUID2`);
            const removeAlbumChildChild = new Album(`someUUID2-1-1`, AlbumType.ALBUM, `someAlbumName6`, `someUUID2-1`);

            syncEngine.photosLibrary.deleteAlbum = jest.fn<typeof syncEngine.photosLibrary.deleteAlbum>()
                .mockImplementationOnce(() => {
                    throw new Error(`Unable to delete album`);
                });

            // The order here does not matter
            await syncEngine.writeAlbums([[removeAlbumChild, removeAlbumParent, removeAlbumChildChild], [], []]);

            expect(syncEngine.photosLibrary.cleanArchivedOrphans).toHaveBeenCalled();
            expect(syncEngine.photosLibrary.stashArchivedAlbum).not.toHaveBeenCalled();
            expect(syncEngine.photosLibrary.retrieveStashedAlbum).not.toHaveBeenCalled();

            expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenCalledTimes(3);
            // Needs to be called from the furthest node
            expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenNthCalledWith(1, removeAlbumChildChild);
            expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenNthCalledWith(2, removeAlbumChild);
            expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenNthCalledWith(3, removeAlbumParent);

            expect(syncEngine.photosLibrary.writeAlbum).toHaveBeenCalledTimes(0);

            expect(warnEvent).toHaveBeenCalledTimes(1);
        });

        describe(`Archive albums`, () => {
            test(`Remote album (locally archived) deleted`, async () => {
                const albumParent = new Album(`someUUID1`, AlbumType.ALBUM, `someAlbumName1`, ``);
                const albumChild = new Album(`someUUID1-1`, AlbumType.ALBUM, `someAlbumName2`, `someUUID1`);
                const albumChildChild = new Album(`someUUID1-1-1`, AlbumType.ARCHIVED, `someAlbumName3`, `someUUID1-1`);
                // The order here does not matter
                await syncEngine.writeAlbums([[albumChild, albumChildChild, albumParent], [], []]);

                expect(syncEngine.photosLibrary.cleanArchivedOrphans).toHaveBeenCalled();
                expect(syncEngine.photosLibrary.retrieveStashedAlbum).not.toHaveBeenCalled();
                expect(syncEngine.photosLibrary.writeAlbum).not.toHaveBeenCalled();

                expect(syncEngine.photosLibrary.stashArchivedAlbum).toHaveBeenCalledTimes(1);
                expect(syncEngine.photosLibrary.stashArchivedAlbum).toHaveBeenNthCalledWith(1, albumChildChild);

                expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenCalledTimes(2);
                // Needs to be called from the furthest node
                expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenNthCalledWith(1, albumChild);
                expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenNthCalledWith(2, albumParent);
            });

            test(`Remote album (locally archived) moved`, async () => {
                const removedAlbumParent = new Album(`someUUID1`, AlbumType.ALBUM, `someAlbumName1`, ``);
                const removedAlbumChild = new Album(`someUUID1-1`, AlbumType.ALBUM, `someAlbumName2`, `someUUID1`);
                const removedAlbumChildChild = new Album(`someUUID1-1-1`, AlbumType.ARCHIVED, `someAlbumName3`, `someUUID1-1`);
                const newAlbum = removedAlbumChildChild;
                // The order here does not matter
                await syncEngine.writeAlbums([[removedAlbumParent, removedAlbumChild, removedAlbumChildChild], [newAlbum], []]);

                expect(syncEngine.photosLibrary.cleanArchivedOrphans).toHaveBeenCalled();

                expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenCalledTimes(2);
                expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenNthCalledWith(1, removedAlbumChild);
                expect(syncEngine.photosLibrary.deleteAlbum).toHaveBeenNthCalledWith(2, removedAlbumParent);

                expect(syncEngine.photosLibrary.stashArchivedAlbum).toHaveBeenCalledTimes(1);
                expect(syncEngine.photosLibrary.stashArchivedAlbum).toHaveBeenNthCalledWith(1, removedAlbumChildChild);

                expect(syncEngine.photosLibrary.retrieveStashedAlbum).toHaveBeenCalledTimes(1);
                expect(syncEngine.photosLibrary.retrieveStashedAlbum).toHaveBeenNthCalledWith(1, newAlbum);

                expect(syncEngine.photosLibrary.writeAlbum).not.toHaveBeenCalled();
            });

            test(`Retrieving from stash - Unable to retrieve album`, async () => {
                const album1 = new Album(`someUUID1`, AlbumType.ARCHIVED, `someAlbumName1`, ``);
                const album2 = new Album(`someUUID2`, AlbumType.ARCHIVED, `someAlbumName2`, ``);

                syncEngine.photosLibrary.retrieveStashedAlbum = jest.fn<typeof syncEngine.photosLibrary.retrieveStashedAlbum>()
                    .mockImplementationOnce(() => {
                        throw new Error(`Unable to retrieve album`);
                    });

                await expect(syncEngine.writeAlbums([[], [album1, album2], []])).rejects.toThrow(/^Unable to retrieve stashed archived album$/);

                expect(syncEngine.photosLibrary.retrieveStashedAlbum).toHaveBeenCalledTimes(1);
                expect(syncEngine.photosLibrary.retrieveStashedAlbum).toHaveBeenNthCalledWith(1, album1);

                expect(syncEngine.photosLibrary.writeAlbum).not.toHaveBeenCalled();
            });

            test(`Stash - Unable to stash album`, async () => {
                const album1 = new Album(`someUUID1`, AlbumType.ARCHIVED, `someAlbumName1`, ``);
                const album2 = new Album(`someUUID2`, AlbumType.ARCHIVED, `someAlbumName2`, ``);

                syncEngine.photosLibrary.stashArchivedAlbum = jest.fn<typeof syncEngine.photosLibrary.stashArchivedAlbum>()
                    .mockImplementationOnce(() => {
                        throw new Error(`Unable to retrieve album`);
                    });

                await expect(() => syncEngine.writeAlbums([[album1, album2], [], []])).rejects.toThrow(/^Unable to stash archived album$/);

                expect(syncEngine.photosLibrary.stashArchivedAlbum).toHaveBeenCalledTimes(1);
                expect(syncEngine.photosLibrary.stashArchivedAlbum).toHaveBeenNthCalledWith(1, album2);

                expect(syncEngine.photosLibrary.writeAlbum).not.toHaveBeenCalled();
            });
        });
    });
});
