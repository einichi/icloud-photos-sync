import {beforeEach, describe, expect, jest, test} from '@jest/globals';
import {EmailNotifier} from '../../src/app/event/email-notifier';
import {iCPSError} from '../../src/app/error/error';
import {ICLOUD_PHOTOS_ERR} from '../../src/app/error/error-codes';
import {iCPSEventLog, iCPSEventRuntimeWarning, iCPSEventSyncEngine} from '../../src/lib/resources/events-types';
import {Asset, AssetType} from '../../src/lib/photos-library/model/asset';
import {FileType} from '../../src/lib/photos-library/model/file-type';
import {Zones} from '../../src/lib/icloud/icloud-photos/query-builder';
import {MockedEventManager, prepareResources} from '../_helpers/_general';
import {defaultConfig} from '../_helpers/_config';

type SentEmail = {
    subject: string,
    text: string
}

type TestableEmailNotifier = EmailNotifier & {
    send: (message: SentEmail) => Promise<void>
}

const makeAsset = (checksum: string, origFilename: string) => new Asset(
    checksum,
    100,
    FileType.fromExtension(`png`),
    10,
    Zones.Primary,
    AssetType.ORIG,
    origFilename,
);

describe(`EmailNotifier`, () => {
    let events: MockedEventManager;

    beforeEach(() => {
        events = prepareResources(true, {
            ...defaultConfig,
            smtpSyncReport: true,
            smtpHost: `smtp.example.com`,
            smtpFrom: `iCloud Photos Sync <sync@example.com>`,
            smtpTo: `owner@example.com`,
        })!.event;
    });

    test(`Sync report lists failed asset writes separately from retry warnings`, async () => {
        const notifier = new EmailNotifier();
        const sentMessages: SentEmail[] = [];
        jest.spyOn(notifier as TestableEmailNotifier, `send`)
            .mockImplementation(async message => {
                sentMessages.push(message);
            });

        const failure = new iCPSError(ICLOUD_PHOTOS_ERR.DOWNLOAD_URL_REFRESH)
            .addCause(new Error(`Request failed with status code 421`));

        events.emit(iCPSEventSyncEngine.START);
        events.emit(iCPSEventLog.WARN, `SyncEngine`, `Retrying asset write for IMG_0001.png after retryable error (attempt 1/3): Request failed with status code 421`);
        events.emit(iCPSEventRuntimeWarning.WRITE_ASSET_ERROR, failure, makeAsset(`c29tZUNoZWNrc3VtMQ==`, `IMG_0001`));
        events.emit(iCPSEventRuntimeWarning.WRITE_ASSET_ERROR, failure, makeAsset(`c29tZUNoZWNrc3VtMg==`, `IMG_0002`));
        events.emit(iCPSEventRuntimeWarning.COUNT_MISMATCH, `All photos`, 2, 2, 1);
        events.emit(iCPSEventSyncEngine.DONE);

        await new Promise(resolve => setImmediate(resolve));

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0].subject).toContain(`completed with warnings`);
        expect(sentMessages[0].subject).toContain(`2 not copied`);
        expect(sentMessages[0].text).toContain(`Files not copied: 2`);
        expect(sentMessages[0].text).toContain(`Warnings/errors: 3 (1 other, 2 failed file(s))`);
        expect(sentMessages[0].text).toContain(`Files Not Copied`);
        expect(sentMessages[0].text).toContain(`ICLOUD_PHOTOS_DOWNLOAD_URL_REFRESH (HTTP 421) (2)`);
        expect(sentMessages[0].text).toContain(`- IMG_0001.png`);
        expect(sentMessages[0].text).toContain(`- IMG_0002.png`);
        expect(sentMessages[0].text).toContain(`WARN RuntimeWarning: Expected 2 CPLAssets & CPLMasters`);
        expect(sentMessages[0].text).not.toContain(`Retrying asset write for IMG_0001.png`);
        expect(sentMessages[0].text).not.toContain(`Error while writing asset IMG_0001.png`);
    });

    test(`Sync report clears failed asset writes when a retry later succeeds`, async () => {
        const notifier = new EmailNotifier();
        const sentMessages: SentEmail[] = [];
        jest.spyOn(notifier as TestableEmailNotifier, `send`)
            .mockImplementation(async message => {
                sentMessages.push(message);
            });

        const failure = new iCPSError(ICLOUD_PHOTOS_ERR.DOWNLOAD_URL_REFRESH)
            .addCause(new Error(`Request failed with status code 421`));

        events.emit(iCPSEventSyncEngine.START);
        events.emit(iCPSEventRuntimeWarning.WRITE_ASSET_ERROR, failure, makeAsset(`c29tZUNoZWNrc3VtMQ==`, `IMG_0001`));
        events.emit(iCPSEventSyncEngine.RETRY, 2, failure, 1000);
        events.emit(iCPSEventSyncEngine.WRITE_ASSET_DOWNLOADED, `IMG_0001.png`, `new`);
        events.emit(iCPSEventSyncEngine.DONE);

        await new Promise(resolve => setImmediate(resolve));

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0].subject).toContain(`0 not copied`);
        expect(sentMessages[0].text).toContain(`Files not copied: 0`);
        expect(sentMessages[0].text).toContain(`Files Not Copied\n----------------\nNone`);
    });
});
