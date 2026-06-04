
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import * as fs from 'fs';
import mockfs from 'mock-fs';
import path from 'path';
import {EventManager} from '../../src/lib/resources/event-manager';
import {iCPSEventRuntimeWarning} from '../../src/lib/resources/events-types';
import {Resources} from '../../src/lib/resources/main';
import {ResourceManager} from '../../src/lib/resources/resource-manager';
import {Validator} from '../../src/lib/resources/validator';
import * as Config from '../_helpers/_config';
import {MockedResourceManager, prepareResources, spyOnEvent} from '../_helpers/_general';

describe(`ResourceManager`, () => {
    describe(`constructor`, () => {
        const originalWriteResourceFile = ResourceManager.prototype._writeResourceFile;
        const originalReadResourceFile = ResourceManager.prototype._readResourceFile;

        beforeEach(() => {
            ResourceManager.prototype._writeResourceFile = jest.fn<typeof ResourceManager.prototype._writeResourceFile>()
                .mockReturnValue();

            ResourceManager.prototype._readResourceFile = jest.fn<typeof ResourceManager.prototype._readResourceFile>();
        });

        afterEach(() => {
            ResourceManager.prototype._writeResourceFile = originalWriteResourceFile;
            ResourceManager.prototype._readResourceFile = originalReadResourceFile;
        });

        test(`should create a new instance of ResourceManager`, () => {
            (ResourceManager.prototype._readResourceFile as jest.Mock)
                .mockReturnValue({
                    libraryVersion: 1,
                    trustToken: undefined,
                });
            const resourceManager = new ResourceManager(Config.defaultConfig);
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.trustToken).toBeUndefined();
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.libraryVersion).toEqual(1);
            expect(resourceManager).toBeInstanceOf(ResourceManager);
            expect(resourceManager._readResourceFile).toHaveBeenCalledTimes(1);
            expect(resourceManager._writeResourceFile).toHaveBeenCalledTimes(1);
            expect(resourceManager._resources).toEqual({
                ...Config.defaultConfig,
                libraryVersion: 1,
            });
        });

        test(`should set the trustToken property if it is present in the appOptions`, () => {
            (ResourceManager.prototype._readResourceFile as jest.Mock)
                .mockReturnValue({
                    libraryVersion: 1,
                });

            const resourceManager = new ResourceManager({
                ...Config.defaultConfig,
                trustToken: Config.trustToken,
            });

            expect(resourceManager._writeResourceFile).toHaveBeenCalledTimes(1);
            // Checking what would have been written
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.trustToken).toEqual(Config.trustToken);
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.libraryVersion).toEqual(1);
            expect(resourceManager._resources).toEqual({
                ...Config.defaultConfig,
                libraryVersion: 1,
                trustToken: Config.trustToken,
                trustTokenCreatedAt: expect.any(Number),
            });
        });

        test(`should set the trustToken property if it is present in the resource file`, () => {
            (ResourceManager.prototype._readResourceFile as jest.Mock)
                .mockReturnValue({
                    libraryVersion: 1,
                    trustToken: Config.trustToken,
                });

            const resourceManager = new ResourceManager(Config.defaultConfig);

            expect(resourceManager._writeResourceFile).toHaveBeenCalledTimes(1);
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.trustToken).toEqual(Config.trustToken);
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.libraryVersion).toEqual(1);
            expect(resourceManager._resources).toEqual({
                ...Config.defaultConfig,
                libraryVersion: 1,
                trustToken: Config.trustToken,
                trustTokenCreatedAt: expect.any(Number),
            });
        });

        test(`should read the resource file from the configured data dir during construction`, () => {
            const resourceFilePaths: string[] = [];
            ResourceManager.prototype._readResourceFile = jest.fn(function (this: ResourceManager) {
                resourceFilePaths.push(this.resourceFilePath);
                return {
                    libraryVersion: 1,
                    trustToken: Config.trustToken,
                };
            });

            new ResourceManager({
                ...Config.defaultConfig,
                trustToken: undefined,
            });

            expect(resourceFilePaths).toEqual([
                path.join(Config.defaultConfig.dataDir, `.icloud-photos-sync`),
            ]);
        });

        test(`should keep the resource file trustToken when appOptions trustToken is undefined`, () => {
            (ResourceManager.prototype._readResourceFile as jest.Mock)
                .mockReturnValue({
                    libraryVersion: 1,
                    trustToken: Config.trustToken,
                });

            const resourceManager = new ResourceManager({
                ...Config.defaultConfig,
                trustToken: undefined,
            });

            expect(resourceManager._writeResourceFile).toHaveBeenCalledTimes(1);
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.trustToken).toEqual(Config.trustToken);
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.libraryVersion).toEqual(1);
            expect(resourceManager._resources).toEqual({
                ...Config.defaultConfig,
                libraryVersion: 1,
                trustToken: Config.trustToken,
                trustTokenCreatedAt: expect.any(Number),
            });
        });

        test(`should set the trustToken property from appOption if it is present in the resource file and the appOptions`, () => {
            (ResourceManager.prototype._readResourceFile as jest.Mock)
                .mockReturnValue({
                    libraryVersion: 1,
                    trustToken: Config.trustTokenModified,
                });

            const resourceManager = new ResourceManager({
                ...Config.defaultConfig,
                trustToken: Config.trustToken,
            });

            expect(resourceManager._writeResourceFile).toHaveBeenCalledTimes(1);
            // Checking what would have been written
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.trustToken).toEqual(Config.trustToken);
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.libraryVersion).toEqual(1);
            expect(resourceManager._resources).toEqual({
                ...Config.defaultConfig,
                libraryVersion: 1,
                trustToken: Config.trustToken,
                trustTokenCreatedAt: expect.any(Number),
            });
        });

        test(`should clear the trustToken if refreshToken is present in the appOptions`, () => {
            (ResourceManager.prototype._readResourceFile as jest.Mock)
                .mockReturnValue({
                    libraryVersion: 1,
                    trustToken: Config.trustTokenModified,
                });

            const resourceManager = new ResourceManager({
                ...Config.defaultConfig,
                trustToken: Config.trustToken,
                refreshToken: true,
            });

            expect(resourceManager._writeResourceFile).toHaveBeenCalledTimes(1);
            // Checking what would have been written
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.trustToken).toBeUndefined();
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.libraryVersion).toEqual(1);
            expect(resourceManager._resources).toEqual({
                ...Config.defaultConfig,
                libraryVersion: 1,
                trustToken: undefined,
                trustTokenCreatedAt: undefined,
                refreshToken: true,
            });
        });

        test(`should set the VAPID credentials property from the resource file while trust token is in appOptions`, () => {
            (ResourceManager.prototype._readResourceFile as jest.Mock)
                .mockReturnValue({
                    libraryVersion: 1,
                    notificationVapidCredentials: {
                        publicKey: `somePublicKey`,
                        privateKey: `somePrivateKey`
                    },
                });

            const resourceManager = new ResourceManager({
                ...Config.defaultConfig,
                trustToken: Config.trustToken,
            });

            expect(resourceManager._writeResourceFile).toHaveBeenCalledTimes(1);
            // Checking what would have been written
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.trustToken).toEqual(Config.trustToken);
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.libraryVersion).toEqual(1);
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.notificationVapidCredentials).toBeDefined();

            // Checking what would have been written
            expect(resourceManager._resources).toEqual({
                ...Config.defaultConfig,
                libraryVersion: 1,
                trustToken: Config.trustToken,
                trustTokenCreatedAt: expect.any(Number),
                notificationVapidCredentials: {
                    publicKey: `somePublicKey`,
                    privateKey: `somePrivateKey`
                },
            });
        });


        test(`should set the VAPID credentials property from the resource file`, () => {
            (ResourceManager.prototype._readResourceFile as jest.Mock)
                .mockReturnValue({
                    libraryVersion: 1,
                    notificationVapidCredentials: {
                        publicKey: `somePublicKey`,
                        privateKey: `somePrivateKey`
                    },
                });

            const resourceManager = new ResourceManager(Config.defaultConfig);

            expect(resourceManager._writeResourceFile).toHaveBeenCalledTimes(1);
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.notificationVapidCredentials).toBeDefined();
            // Checking what would have been written
            expect(resourceManager._resources).toEqual({
                ...Config.defaultConfig,
                libraryVersion: 1,
                notificationVapidCredentials: {
                    publicKey: `somePublicKey`,
                    privateKey: `somePrivateKey`
                },
            });
        });

        test(`should set notification subscriptions from the resource file`, () => {
            (ResourceManager.prototype._readResourceFile as jest.Mock)
                .mockReturnValue({
                    libraryVersion: 1,
                    notificationSubscriptions: {
                        "https://some.endpoint": {
                            endpoint: `https://some.endpoint`,
                            keys: {
                                p256dh: `someKey`,
                                auth: `someAuth`
                            }
                        }
                    }   
                });

            const resourceManager = new ResourceManager(Config.defaultConfig);

            expect(resourceManager._writeResourceFile).toHaveBeenCalledTimes(1);
            expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.notificationSubscriptions).toBeDefined();
            // Checking what would have been written
            expect(resourceManager._resources).toEqual({
                ...Config.defaultConfig,
                libraryVersion: 1,
                notificationSubscriptions: {
                    "https://some.endpoint": {
                        endpoint: `https://some.endpoint`,
                        keys: {
                            p256dh: `someKey`,
                            auth: `someAuth`
                        }
                    }
                }   
            });
        });
    });

    describe(`resource file`, () => {
        const resourceFilePath = `${Config.defaultConfig.dataDir}/.icloud-photos-sync`;
        let resourceManager: ResourceManager;
        let eventManager: EventManager;
        let validator: Validator;

        beforeEach(() => {
            mockfs({});
            prepareResources(false);

            const instances = Resources.setup(Config.defaultConfig);

            eventManager = instances.event;
            resourceManager = instances.manager;
            validator = instances.validator;
        });

        afterEach(() => {
            mockfs.restore();
        });

        describe(`_readResourceFile`, () => {
            test(`should read the contents of the resource file and return a valid resource file object`, () => {
                const data = {
                    libraryVersion: 1,
                    trustToken: Config.trustToken,
                };

                mockfs({
                    [resourceFilePath]: JSON.stringify(data),
                });

                validator.validateResourceFile = jest.fn<typeof validator.validateResourceFile>()
                    .mockReturnValue(data);

                const result = resourceManager._readResourceFile();

                expect(validator.validateResourceFile).toHaveBeenCalledWith(data);

                expect(result).toEqual(data);
            });

            test(`should emit a NO_RESOURCE_FILE_FOUND event and return a default resource file object if the resource file cannot be read`, () => {
                mockfs({
                    [`${Config.defaultConfig.dataDir}/.icloud-photos-sync`]: mockfs.file({
                        content: ``,
                        mode: 0o000, // Make the file unreadable
                    }),
                });

                const noResourceFileFoundEvent = spyOnEvent(eventManager._eventBus, iCPSEventRuntimeWarning.RESOURCE_FILE_ERROR);

                const result = resourceManager._readResourceFile();

                expect(noResourceFileFoundEvent).toHaveBeenCalled();
                expect(result).toEqual({
                    libraryVersion: 1,
                    trustToken: undefined,
                });
            });

            test(`should emit a RESOURCE_FILE_INVALID event and return a default resource file object if the resource file is invalid`, () => {
                mockfs({
                    [resourceFilePath]: JSON.stringify({
                        invalid: `json`,
                    }),
                });
                const noResourceFileFoundEvent = spyOnEvent(eventManager._eventBus, iCPSEventRuntimeWarning.RESOURCE_FILE_ERROR);

                const result = resourceManager._readResourceFile();

                expect(noResourceFileFoundEvent).toHaveBeenCalled();
                expect(result).toEqual({
                    libraryVersion: 1,
                    trustToken: undefined,
                });
            });
        });

        describe(`_writeResourceFile`, () => {
            test(`should write the resource file to disk with the correct contents`, () => {
                mockfs({
                    [Config.defaultConfig.dataDir]: {},
                });

                resourceManager._resources.libraryVersion = 1;
                resourceManager._resources.trustToken = Config.trustToken;

                resourceManager._writeResourceFile();

                const resourceFileData = JSON.parse(fs.readFileSync(resourceFilePath, {encoding: `utf8`}));
                expect(resourceFileData).toEqual({
                    libraryVersion: 1,
                    trustToken: Config.trustToken,
                });
            });

            test(`should emit an error event if the resource file cannot be written`, () => {
                mockfs({
                    [resourceFilePath]: mockfs.file({
                        content: ``,
                        mode: 0o444, // Make the file read-only
                    }),
                });
                const warningEvent = spyOnEvent(eventManager._eventBus, iCPSEventRuntimeWarning.RESOURCE_FILE_ERROR);

                resourceManager._writeResourceFile();

                expect(warningEvent).toHaveBeenCalledWith(expect.any(Error));
            });

            test(`should overwrite an existing resource file with the correct contents`, () => {
                mockfs({
                    [resourceFilePath]: JSON.stringify({
                        libraryVersion: 0,
                        trustToken: Config.trustToken,
                    }),
                });

                resourceManager._resources.libraryVersion = 1;
                resourceManager._resources.trustToken = Config.trustTokenModified;

                resourceManager._writeResourceFile();

                const resourceFileData = JSON.parse(fs.readFileSync(resourceFilePath, {encoding: `utf8`}));
                expect(resourceFileData).toEqual({
                    libraryVersion: 1,
                    trustToken: Config.trustTokenModified,
                });
            });
        });
    });

    describe(`getter and setter`, () => {
        let resourceManager: MockedResourceManager;

        const resources = {
            ...Config.defaultConfig,
            sessionSecret: Config.iCloudAuthSecrets.sessionSecret,
            libraryVersion: 1,
            primaryZone: Config.primaryZoneInPrivateArea,
            sharedZone: Config.sharedZoneInPrivateArea,
        };

        beforeEach(() => {
            resourceManager = prepareResources(true, resources as any)!.manager;
        });

        describe(`dataDir`, () => {
            test(`should return the data dir from the resources`, () => {
                expect(resourceManager.dataDir).toEqual(resources.dataDir);
            });
        });

        describe(`resourceFilePath`, () => {
            test(`should return the path to the resource file`, () => {
                const expectedPath = path.join(resources.dataDir, `.icloud-photos-sync`);
                expect(resourceManager.resourceFilePath).toEqual(expectedPath);
            });
        });

        describe(`logFilePath`, () => {
            test(`should return the path to the log file `, () => {
                resourceManager._resources.logToCli = false;
                const expectedPath = path.join(resources.dataDir, `.icloud-photos-sync.log`);
                expect(resourceManager.logFilePath).toEqual(expectedPath);
            });
        });

        describe(`libraryLockFile`, () => {
            test(`should return the path to the library lock file`, () => {
                const expectedPath = path.join(resources.dataDir, `.library.lock`);
                expect(resourceManager.lockFilePath).toEqual(expectedPath);
            });
        });

        describe(`metricsFilePath`, () => {
            test(`should return the path to the metrics file if exportMetrics is enabled`, () => {
                resourceManager._resources.exportMetrics = true;
                const expectedPath = path.join(resources.dataDir, `.icloud-photos-sync.metrics`);
                expect(resourceManager.metricsFilePath).toEqual(expectedPath);
            });

            test(`should return the path to the metrics file if exportMetrics is disabled`, () => {
                resourceManager._resources.exportMetrics = true;
                const expectedPath = path.join(resources.dataDir, `.icloud-photos-sync.metrics`);
                expect(resourceManager.metricsFilePath).toEqual(expectedPath);
            });
        });

        describe(`harFilePath`, () => {
            test(`should return the path to the HAR file if enableNetworkCapture is enabled`, () => {
                resourceManager._resources.enableNetworkCapture = true;
                const expectedPath = path.join(resources.dataDir, `.icloud-photos-sync.har`);
                expect(resourceManager.harFilePath).toEqual(expectedPath);
            });

            test(`should return the path to the HAR file if enableNetworkCapture is disabled`, () => {
                resourceManager._resources.enableNetworkCapture = false;
                const expectedPath = path.join(resources.dataDir, `.icloud-photos-sync.har`);
                expect(resourceManager.harFilePath).toEqual(expectedPath);
            });
        });

        describe(`libraryVersion`, () => {
            test(`should return the library version from the resources`, () => {
                (resourceManager._readResourceFile as jest.Mock).mockReset(); // Was called during construction
                expect(resourceManager.libraryVersion).toEqual(resources.libraryVersion);
                expect(resourceManager._readResourceFile).not.toHaveBeenCalled();
            });
        });

        describe(`trustToken`, () => {
            test(`should return the trust token from the file`, () => {
                resourceManager._resources.trustToken = Config.trustTokenModified;
                resourceManager._readResourceFile = jest.fn<typeof resourceManager._readResourceFile>()
                    .mockReturnValue({
                        libraryVersion: 1,
                        trustToken: resources.trustToken,
                    });
                expect(resourceManager.trustToken).toEqual(resources.trustToken);
                expect(resourceManager._readResourceFile).toHaveBeenCalled();
            });

            test(`should return undefined, if trust token is not set in file`, () => {
                resourceManager._readResourceFile = jest.fn<typeof resourceManager._readResourceFile>()
                    .mockReturnValue({
                        libraryVersion: 1,
                        trustToken: undefined,
                    });
                expect(resourceManager.trustToken).toBeUndefined();
                expect(resourceManager._readResourceFile).toHaveBeenCalled();
            });

            test(`should retain an in-memory trust token if the resource file returns no token`, () => {
                resourceManager._resources.trustToken = Config.trustTokenModified;
                resourceManager._readResourceFile = jest.fn<typeof resourceManager._readResourceFile>()
                    .mockReturnValue({
                        libraryVersion: 1,
                        trustToken: undefined,
                    });
                expect(resourceManager.trustToken).toEqual(Config.trustTokenModified);
                expect(resourceManager._readResourceFile).toHaveBeenCalled();
            });
        });

        describe(`trustToken setter`, () => {
            test(`should set the trust token in the resources and write it to the resource file`, () => {
                (resourceManager._writeResourceFile as jest.Mock).mockReset();
                resourceManager.trustToken = Config.trustTokenModified;
                expect(resourceManager._writeResourceFile).toHaveBeenCalledTimes(1);
                // Checking what would have been written
                expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.trustToken).toEqual(Config.trustTokenModified);
                expect(((resourceManager._writeResourceFile as jest.Mock).mock.contexts[0] as ResourceManager)._resources.libraryVersion).toEqual(1);
                expect(resourceManager._resources.trustToken).toEqual(Config.trustTokenModified);
                expect(resourceManager._resources.trustTokenCreatedAt).toEqual(expect.any(Number));
            });
        });

        describe(`trust token expiry`, () => {
            test(`should calculate trust token expiry from creation timestamp`, () => {
                resourceManager._resources.trustToken = Config.trustToken;
                resourceManager._resources.trustTokenCreatedAt = 1000;
                resourceManager._resources.trustTokenLifetimeDays = 30;

                expect(resourceManager.trustTokenCreatedAt).toEqual(1000);
                expect(resourceManager.trustTokenExpiresAt).toEqual(1000 + (30 * 24 * 60 * 60 * 1000));
            });

            test(`should return undefined token expiry when no token is stored`, () => {
                resourceManager._resources.trustToken = undefined;
                resourceManager._resources.trustTokenCreatedAt = 1000;

                expect(resourceManager.trustTokenExpiresAt).toBeUndefined();
            });
        });

        describe(`smtpConfig`, () => {
            test(`should return undefined when SMTP configuration is incomplete`, () => {
                expect(resourceManager.smtpConfig).toBeUndefined();
            });

            test(`should parse SMTP configuration recipients`, () => {
                resourceManager._resources.smtpHost = `smtp.example.com`;
                resourceManager._resources.smtpPort = 587;
                resourceManager._resources.smtpSecure = `starttls`;
                resourceManager._resources.smtpUser = `smtp-user`;
                resourceManager._resources.smtpPassword = `smtp-password`;
                resourceManager._resources.smtpFrom = `ICPS <icps@example.com>`;
                resourceManager._resources.smtpTo = `one@example.com, two@example.com`;

                expect(resourceManager.smtpConfig).toEqual({
                    host: `smtp.example.com`,
                    port: 587,
                    secure: `starttls`,
                    user: `smtp-user`,
                    password: `smtp-password`,
                    from: `ICPS <icps@example.com>`,
                    to: [`one@example.com`, `two@example.com`],
                });
            });

            test(`should format SMTP from address with display name`, () => {
                resourceManager._resources.smtpHost = `smtp.example.com`;
                resourceManager._resources.smtpPort = 587;
                resourceManager._resources.smtpSecure = `starttls`;
                resourceManager._resources.smtpFrom = `notifications@burg.in`;
                resourceManager._resources.smtpFromName = `Photo Sync`;
                resourceManager._resources.smtpTo = `one@example.com`;

                expect(resourceManager.smtpConfig).toEqual(expect.objectContaining({
                    from: `"Photo Sync" <notifications@burg.in>`,
                }));
            });
        });

        describe(`VAPID Credentials`, () => {
            test(`should return the VAPID credentials from the resources`, () => {
                resourceManager._resources.notificationVapidCredentials = Config.notificationVapidCredentials;
                expect(resourceManager.notificationVapidCredentials).toEqual(Config.notificationVapidCredentials);
            })

            test(`should create VAPID credentials if not present in the resources`, () => {
                (resourceManager._writeResourceFile as jest.Mock).mockReset();
                resourceManager._resources.notificationVapidCredentials = undefined!;
                expect(resourceManager.notificationVapidCredentials).toEqual(expect.objectContaining({
                    publicKey: expect.any(String),
                    privateKey: expect.any(String),
                }))
                expect(resourceManager._writeResourceFile).toHaveBeenCalledTimes(1);
            })
        })

        describe(`Notification Subscription`, () => {
            test(`should return the notification subscription from the resources`, () => {
                const notificationSubscriptions = {
                    'https://example.com/endpoint': {
                        endpoint: `https://example.com/endpoint`,
                        keys: {
                            p256dh: `p256dhKey`,
                            auth: `authKey`,
                        },
                    }
                }
                resourceManager._resources.notificationSubscriptions = notificationSubscriptions;
                expect(resourceManager.notificationSubscriptions).toEqual([notificationSubscriptions[`https://example.com/endpoint`]]);
            });

            test(`should return no notification subscription`, () => {
                expect(resourceManager.notificationSubscriptions).toEqual([]);
            });

            test(`should add a new notification subscription to the resources and write it to the resource file`, () => {
                (resourceManager._writeResourceFile as jest.Mock).mockReset();
                const subscription = {
                    endpoint: `https://example.com/endpoint`,
                    keys: {
                        p256dh: `p256dhKey`,
                        auth: `authKey`,
                    },
                };
                resourceManager.addNotificationSubscription(subscription);
                expect(resourceManager._writeResourceFile).toHaveBeenCalledTimes(1);
                expect(resourceManager._resources.notificationSubscriptions).toEqual({
                    [subscription.endpoint]: subscription,
                });
            });

            test(`should remove a notification subscription from the resources and write it to the resource file`, () => {
                (resourceManager._writeResourceFile as jest.Mock).mockReset();
                const subscription = {
                    endpoint: `https://example.com/endpoint`,
                    keys: {
                        p256dh: `p256dhKey`,
                        auth: `authKey`,
                    },
                };
                resourceManager._resources.notificationSubscriptions = {
                    [subscription.endpoint]: subscription,
                };
                resourceManager.removeNotificationSubscription(subscription);
                expect(resourceManager._writeResourceFile).toHaveBeenCalledTimes(1);
                expect(resourceManager._resources.notificationSubscriptions).toEqual({});
            })

            test(`should silently fail when trying to remove non-existing notification subscription`, () => {
                (resourceManager._writeResourceFile as jest.Mock).mockReset();
                const subscription = {
                    endpoint: `https://example.com/endpoint`,
                    keys: {
                        p256dh: `p256dhKey`,
                        auth: `authKey`,
                    },
                };
                const someOtherSubscription = {
                    endpoint: `https://example.com/other-endpoint`,
                    keys: {
                        p256dh: `p256dhKey`,
                        auth: `authKey`,
                    },
                };
                resourceManager._resources.notificationSubscriptions = {
                    [subscription.endpoint]: subscription,
                };
                resourceManager.removeNotificationSubscription(someOtherSubscription);
                expect(resourceManager._writeResourceFile).toHaveBeenCalledTimes(0);
                expect(resourceManager._resources.notificationSubscriptions).toEqual({
                    [subscription.endpoint]: subscription,
                });
            })
        });

        describe(`username`, () => {
            test(`should return the username from the resources`, () => {
                expect(resourceManager.username).toEqual(resources.username);
            });

            test(`should throw if complete credentials are not set`, () => {
                resourceManager._resources.username = undefined!;
                expect(() => resourceManager.username).toThrow(/^Apple ID credentials have not been provided$/);
            });
        });

        describe(`password`, () => {
            test(`should return the password from the resources`, () => {
                expect(resourceManager.password).toEqual(resources.password);
            });

            test(`should throw if complete credentials are not set`, () => {
                resourceManager._resources.password = undefined!;
                expect(() => resourceManager.password).toThrow(/^Apple ID credentials have not been provided$/);
            });
        });

        describe(`credentials`, () => {
            test(`should report credentials as available`, () => {
                expect(resourceManager.hasCredentials).toBeTruthy();
            });

            test(`should report credentials as unavailable when username or password is missing`, () => {
                resourceManager._resources.password = undefined!;
                expect(resourceManager.hasCredentials).toBeFalsy();
            });

            test(`should report startup credentials`, () => {
                expect(resourceManager.credentialsProvidedAtStartup).toBeTruthy();
            });

            test(`should store web ui credentials in memory when startup credentials are absent`, () => {
                resourceManager._resources.credentialsProvidedAtStartup = false;
                resourceManager._resources.username = undefined!;
                resourceManager._resources.password = undefined!;
                (resourceManager._writeResourceFile as jest.Mock).mockReset();

                const accepted = resourceManager.setCredentials({
                    username: `web@icloud.com`,
                    password: `webPass`,
                });

                expect(accepted).toBeTruthy();
                expect(resourceManager.username).toEqual(`web@icloud.com`);
                expect(resourceManager.password).toEqual(`webPass`);
                expect(resourceManager._writeResourceFile).not.toHaveBeenCalled();
            });

            test(`should not replace startup credentials`, () => {
                const accepted = resourceManager.setCredentials({
                    username: `web@icloud.com`,
                    password: `webPass`,
                });

                expect(accepted).toBeFalsy();
                expect(resourceManager.username).toEqual(resources.username);
                expect(resourceManager.password).toEqual(resources.password);
            });
        });

        describe(`webServerPort`, () => {
            test(`should return the port from the resources`, () => {
                expect(resourceManager.webServerPort).toEqual(resources.port);
            });
        });

        describe(`webBasePath`, () => {
            test(`should return the base path from the resources`, () => {
                expect(resourceManager.webBasePath).toEqual(resources.webBasePath);
            });
        });

        describe(`notificationWebUrl`, () => {
            test(`should use localhost and the web server port by default`, () => {
                resourceManager._resources.port = 8080;
                resourceManager._resources.webBasePath = `/photos`;

                expect(resourceManager.notificationWebUrl).toEqual(`http://localhost:8080/photos/state`);
            });

            test(`should use the notification host IP and exposed port when configured`, () => {
                resourceManager._resources.port = 80;
                resourceManager._resources.webBasePath = `/photos`;
                resourceManager._resources.notificationWebHostIp = `192.168.1.50`;
                resourceManager._resources.notificationWebExposedPort = 8081;

                expect(resourceManager.notificationWebUrl).toEqual(`http://192.168.1.50:8081/photos/state`);
            });
        });

        describe(`maxRetries`, () => {
            test(`should return the max retries from the resources`, () => {
                expect(resourceManager.maxRetries).toEqual(resources.maxRetries);
            });
        });

        describe(`downloadThreads`, () => {
            test(`should return the download threads from the resources`, () => {
                expect(resourceManager.downloadThreads).toEqual(resources.downloadThreads);
            });
        });

        describe(`schedule`, () => {
            test(`should return the schedule from the resources`, () => {
                expect(resourceManager.schedule).toEqual(resources.schedule);
            });
        });

        describe(`enableCrashReporting`, () => {
            test(`should return the enable crash reporting flag from the resources`, () => {
                expect(resourceManager.enableCrashReporting).toEqual(resources.enableCrashReporting);
            });
        });

        describe(`failOnMfa`, () => {
            test(`should return the fail on MFA flag from the resources`, () => {
                expect(resourceManager.failOnMfa).toEqual(resources.failOnMfa);
            });
        });

        describe(`force`, () => {
            test(`should return the force flag from the resources`, () => {
                expect(resourceManager.force).toEqual(resources.force);
            });
        });

        describe(`remoteDelete`, () => {
            test(`should return the remote delete flag from the resources`, () => {
                expect(resourceManager.remoteDelete).toEqual(resources.remoteDelete);
            });
        });

        describe(`logLevel`, () => {
            test(`should return the log level from the resources`, () => {
                expect(resourceManager.logLevel).toEqual(resources.logLevel);
            });
        });

        describe(`silent`, () => {
            test(`should return the silent flag from the resources`, () => {
                expect(resourceManager.silent).toEqual(resources.silent);
            });
        });

        describe(`logToCli`, () => {
            test(`should return the log to CLI flag from the resources`, () => {
                expect(resourceManager.logToCli).toEqual(resources.logToCli);
            });
        });

        describe(`suppressWarnings`, () => {
            test(`should return the suppress warnings flag from the resources`, () => {
                expect(resourceManager.suppressWarnings).toEqual(resources.suppressWarnings);
            });
        });

        describe(`exportMetrics`, () => {
            test(`should return the export metrics flag from the resources`, () => {
                expect(resourceManager.exportMetrics).toEqual(resources.exportMetrics);
            });
        });

        describe(`metadataRate`, () => {
            test(`should return the metadata rate from the resources`, () => {
                expect(resourceManager.metadataRate).toEqual(resources.metadataRate);
            });
        });

        describe(`enableNetworkCapture`, () => {
            test(`should return the enable network capture flag from the resources`, () => {
                expect(resourceManager.enableNetworkCapture).toEqual(resources.enableNetworkCapture);
            });
        });

        describe(`legacyLogin`, () => {
            test(`should return the legacy login flag from the resources`, () => {
                expect(resourceManager.legacyLogin).toEqual(resources.legacyLogin);
            });
        });

        describe(`region`, () => {
            test(`should return the region from the resources`, () => {
                expect(resourceManager.region).toEqual(resources.region);
            });
        });

        describe(`healthCheckURL`, () => {
            test(`should return the healthCheckURL from the resources`, () => {
                expect(resourceManager.healthCheckUrl).toEqual(resources.healthCheckUrl);
            });
        });

        describe(`sessionSecret`, () => {
            test(`should return the session secret from the resources`, () => {
                expect(resourceManager.sessionSecret).toEqual(resources.sessionSecret);
            });

            test(`should throw an error if no session secret is set`, () => {
                resourceManager._resources.sessionSecret = undefined!;
                expect(() => resourceManager.sessionSecret).toThrow(/^No session secret present$/);
            });
        });

        describe(`sessionSecret setter`, () => {
            test(`should set the session secret in the resources`, () => {
                resourceManager.sessionSecret = Config.iCloudAuthSecrets.sessionSecretModified;
                expect(resourceManager._resources.sessionSecret).toEqual(Config.iCloudAuthSecrets.sessionSecretModified);
            });
        });

        describe(`primaryZone`, () => {
            test(`should return the primary zone from the resources`, () => {
                expect(resourceManager.primaryZone).toEqual(resources.primaryZone);
            });

            test(`should throw an error if no primary zone is set`, () => {
                resourceManager._resources.primaryZone = undefined!;
                expect(() => resourceManager.primaryZone).toThrow(/^No primary photos zone present$/);
            });
        });

        describe(`primaryZone setter`, () => {
            test(`should set the primary zone in the resources`, () => {
                resourceManager._resources.primaryZone = undefined!;
                resourceManager.primaryZone = Config.primaryZoneInPrivateArea;
                expect(resourceManager._resources.primaryZone).toEqual(Config.primaryZoneInPrivateArea);
            });
        });

        describe(`sharedZone`, () => {
            test(`should return the shared zone from the resources`, () => {
                expect(resourceManager.sharedZone).toEqual(resources.sharedZone);
            });

            test(`should throw an error if no shared zone is set`, () => {
                resourceManager._resources.sharedZone = undefined!;
                expect(() => resourceManager.sharedZone).toThrow(/^No shared photos zone present$/);
            });
        });

        describe(`sharedZone setter`, () => {
            test(`should set the shared zone in the resources`, () => {
                resourceManager._resources.sharedZone = undefined!;
                resourceManager.sharedZone = Config.sharedZoneInPrivateArea;
                expect(resourceManager._resources.sharedZone).toEqual(Config.sharedZoneInPrivateArea);
            });
        });

        describe(`sharedZoneAvailable`, () => {
            test(`should return true if the shared zone is set`, () => {
                expect(resourceManager.sharedZoneAvailable).toBeTruthy();
            });

            test(`should return false if the shared zone is not set`, () => {
                resourceManager._resources.sharedZone = undefined!;
                expect(resourceManager.sharedZoneAvailable).toBeFalsy();
            });
        });
    });
});
