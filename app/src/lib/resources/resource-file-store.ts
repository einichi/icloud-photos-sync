import {readFileSync, writeFileSync} from "fs";
import {jsonc} from "jsonc";
import {RESOURCES_ERR} from "../../app/error/error-codes.js";
import {iCPSError} from "../../app/error/error.js";
import * as PHOTOS_LIBRARY from '../photos-library/constants.js';
import {iCPSEventRuntimeWarning} from "./events-types.js";
import {Resources} from "./main.js";
import {FILE_ENCODING, ResourceFile, iCPSResources} from "./resource-types.js";

/**
 * Handles reading and writing the persisted resource file.
 */
export class ResourceFileStore {
    constructor(
        private readonly resourceFilePath: string,
        private readonly logSource: object,
    ) {}

    /**
     * Reads the resource file from disk and parses it.
     * @returns The validated resource file, or a default file if reading fails
     */
    read(): ResourceFile {
        try {
            Resources.logger(this.logSource).debug(`Reading resource file from ${this.resourceFilePath}`);
            const resourceFileData = jsonc.parse(readFileSync(this.resourceFilePath, {encoding: FILE_ENCODING}));
            const resourceFile = Resources.validator().validateResourceFile(resourceFileData);
            Resources.logger(this.logSource).info(`Loaded resource file from ${this.resourceFilePath} (trust token: ${resourceFile.trustToken ? `present` : `absent`})`);
            return resourceFile;
        } catch (err) {
            Resources.logger(this.logSource).warn(`Unable to load resource file from ${this.resourceFilePath}; using default resource file`);
            Resources.emit(iCPSEventRuntimeWarning.RESOURCE_FILE_ERROR,
                new iCPSError(RESOURCES_ERR.UNABLE_TO_READ_FILE).addCause(err));
            return {
                libraryVersion: PHOTOS_LIBRARY.LIBRARY_VERSION,
                trustToken: undefined,
            };
        }
    }

    /**
     * Writes the selected persisted resources to disk.
     * @param resources - Effective application resources
     */
    write(resources: iCPSResources) {
        try {
            const formattedResourceFile = this.formatResourceFile(resources);
            const resourceFileData = jsonc.stringify(formattedResourceFile, null, 4);
            Resources.logger(this.logSource).info(`Writing resource file to ${this.resourceFilePath} (trust token: ${formattedResourceFile.trustToken ? `present` : `absent`})`);

            writeFileSync(this.resourceFilePath, resourceFileData, {encoding: FILE_ENCODING, flush: true});
        } catch (err) {
            Resources.emit(iCPSEventRuntimeWarning.RESOURCE_FILE_ERROR,
                new iCPSError(RESOURCES_ERR.UNABLE_TO_WRITE_FILE).addCause(err));
        }
    }

    private formatResourceFile(resources: iCPSResources): ResourceFile {
        return {
            libraryVersion: resources.libraryVersion,
            trustToken: resources.trustToken,
            trustTokenCreatedAt: resources.trustTokenCreatedAt,
            notificationVapidCredentials: resources.notificationVapidCredentials,
            notificationSubscriptions: resources.notificationSubscriptions
        };
    }
}
