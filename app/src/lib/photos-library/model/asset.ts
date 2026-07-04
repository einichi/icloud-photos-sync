import path from 'path';
import {AssetID} from '../../icloud/icloud-photos/query-parser.js';
import {FileType} from './file-type.js';
import {Stats} from 'fs';
import fs from 'fs/promises';
import {PEntity} from './photos-entity.js';
import {iCPSError} from '../../../app/error/error.js';
import {LIBRARY_ERR} from '../../../app/error/error-codes.js';
import {Zones} from '../../icloud/icloud-photos/query-builder.js';
import {PRIMARY_ASSET_DIR, SHARED_ASSET_DIR} from '../constants.js';
import {Resources} from '../../resources/main.js';
import {AssetChecksum} from '../asset-checksum.js';

/**
 * Representing the possible asset types
 */
export enum AssetType {
    /**
     * Shows that this is the original file
     */
    ORIG = 0,
    /**
     * Shows that this is the latest edit
     */
    EDIT = 1,
    /**
     * Shows that this is a live photo
     */
    LIVE = 2
}

const UNSAFE_FILENAME_CHARS = /[/:\\]/g;

/**
 * Sanitizes an iCloud-provided filename segment for use as a local path basename.
 * @param name - Filename segment without extension
 * @returns Filename segment safe to join below the library directory
 */
export function sanitizeAssetFilenameSegment(name: string): string {
    const sanitizedName = name.replaceAll(UNSAFE_FILENAME_CHARS, `_`).trim();
    return sanitizedName.length > 0 ? sanitizedName : `unnamed`;
}

/**
 * This class represents an Asset in the Photo Library
 */
export class Asset implements PEntity<Asset> {
    /**
     * Checksum of the asset
     */
    fileChecksum: string;
    /**
     * File size in bytes of this asset
     */
    size: number;
    /**
     * Modified timestamp as epoch timestamp (ms since epoch)
     */
    modified: number;
    /**
     * The file type of this asset
     */
    fileType: FileType;
    /**
     * Shows which version of the asset this is
     */
    assetType: AssetType;
    /**
     * The original filename of this asset
     */
    origFilename: string;

    /**
     * The zone this file is belonging to
     */
    zone: Zones;

    /**
     * The wrapping key of this asset (unknown usage, taken from backend, only present if fetched from CPL)
     */
    wrappingKey?: string;
    /**
     * The reference checksum of this asset (unknown usage, taken from backend, only present if fetched from CPL)
     */
    referenceChecksum?: string;
    /**
     * The download URL of this asset (only present if fetched from CPL)
     */
    downloadURL?: string;
    /**
     * The record containing the downloadable resource. For originals this is the CPLMaster, while recordName remains the CPLAsset.
     */
    downloadRecordName?: string;
    /**
     * Record name of the associated CPL Asset
     */
    recordName?: string;
    /**
     * Flag, if this asset is favorite
     */
    isFavorite?: boolean;

    /**
     * Creates a new Asset object
     * @param fileChecksum -
     * @param size -
     * @param fileType -
     * @param modified -
     * @param zone - Which zone is this asset belonging to
     * @param assetType - If this asset is the original or an edit
     * @param origFilename - The original filename, extracted from the parent object
     * @param wrappingKey -
     * @param referenceChecksum -
     * @param downloadURL -
     */
    constructor(fileChecksum: string, size: number, fileType: FileType, modified: number, zone: Zones, assetType?: AssetType, origFilename?: string, wrappingKey?: string, referenceChecksum?: string, downloadURL?: string, recordName?: string, isFavorite?: boolean, downloadRecordName?: string) {
        this.fileChecksum = fileChecksum;
        this.size = size;
        this.fileType = fileType;
        this.modified = modified;
        this.zone = zone;
        this.assetType = assetType;
        this.origFilename = origFilename;
        this.wrappingKey = wrappingKey;
        this.referenceChecksum = referenceChecksum;
        this.downloadURL = downloadURL;
        this.recordName = recordName;
        this.isFavorite = isFavorite;
        this.downloadRecordName = downloadRecordName;
    }

    /**
     * Creates an Asset from the information provided by the backend
     * @param asset - The AssetID object returned from the backend
     * @param fileTypeDescriptor - The assetType string, describing the filetype
     * @param fileTypeExt - The assetTypes's extension as derived from the encoded filename
     * @param modified - The modified date as returned from the backend (in ms since epoch)
     * @param origFilename - The original filename, extracted from the parent object
     * @param assetType - If this asset is the original or an edit
     * @param zone - Specifies the zone this asset is belonging to
     * @returns An Asset based on the backend objects
     * @throws An iCPSError, if the asset file descriptor is not supported
     */
    static fromCPL(asset: AssetID, fileTypeDescriptor: string, fileTypeExt: string, modified: number, origFilename: string, assetType: AssetType, recordName: string, isFavorite: number, zone: string, downloadRecordName?: string): Asset {
        return new Asset(
            asset.fileChecksum,
            asset.size,
            FileType.fromAssetType(fileTypeDescriptor, fileTypeExt),
            modified,
            zone === `PrimarySync` ? Zones.Primary : Zones.Shared,
            assetType,
            origFilename,
            asset.wrappingKey,
            asset.referenceChecksum,
            asset.downloadURL,
            recordName,
            isFavorite === 1,
            downloadRecordName,
        );
    }

    /**
     * Creates an Asset from a given file
     * @param fileName - The file name of the file
     * @param stats - The metadata associated with the file
     * @param zone - Specifies the zone this asset is belonging to
     * @returns An Asset based on the file information
     * @throws An iCPSError, if the asset file extension is not supported
     */
    static fromFile(fileName: string, stats: Stats, zone: Zones): Asset {
        return new Asset(
            Buffer.from(path.basename(fileName, path.extname(fileName)), `base64url`).toString(`base64`),
            stats.size,
            FileType.fromExtension(path.extname(fileName)),
            stats.mtimeMs,
            zone,
        );
    }

    /**
     * Compares the provided asset to this asset instance
     * @param asset - The asset to compare to
     * @returns True if provided asset matches this instance (based on fileChecksum, fileType, size and modified timestamp)
     */
    equal(asset: Asset): boolean {
        return asset
                && this.fileChecksum === asset.fileChecksum
                && this.fileType.equal(asset.fileType)
                && this.size === asset.size
                && this.withinRange(this.modified, asset.modified, 1000);
    }

    /**
     * Should only be called on a 'remote' entity. Will apply the local entity's properties to the remote one
     * @param _localEntity - The local entity
     * @returns This object with the applied properties
     */
    apply(_localEntity: Asset): Asset {
        return this;
    }

    /**
     *
     * @returns The full asset file path under the provided directory
     */
    getAssetFilePath() {
        return path.format({
            dir: path.join(Resources.manager().dataDir, this.zone === Zones.Primary ? PRIMARY_ASSET_DIR : SHARED_ASSET_DIR),
            name: this.getAssetFilename(),
        });
    }

    /**
     *
     * @returns A filename safe-encoded UUID of this instance with the correct file extension
     */
    getAssetFilename(): string {
        return path.format({
            name: Buffer.from(this.fileChecksum, `base64`).toString(`base64url`), // Since checksum seems to be base64 encoded
            ext: this.fileType.getExtension(),
        });
    }

    /**
     *
     * @returns The human readable / pretty printed filename of this asset, based on the filename of the original file imported.
     */
    getPrettyFilename(): string {
        const safeOrigFilename = sanitizeAssetFilenameSegment(this.origFilename ?? ``);
        return path.format({
            name: safeOrigFilename + (this.assetType === AssetType.EDIT ? `-edited` : ``) + (this.assetType === AssetType.LIVE ? `-live` : ``),
            ext: this.fileType.getExtension(),
        });
    }

    /**
     *
     * @returns The UUID of this instance
     */
    getUUID(): string {
        return this.fileChecksum;
    }

    /**
     * Verifies that the object representation matches the given file
     * @returns True if this file exists and matches this object representation
     * @throws An error, if verification fails
     */
    async verify(): Promise<boolean> {
        let fileStat: Stats;
        const filePath = this.getAssetFilePath();
        try {
            fileStat = await fs.stat(filePath);
        } catch (err) {
            throw new iCPSError(LIBRARY_ERR.ASSET_NOT_FOUND)
                .addCause(err)
                .addMessage(filePath);
        }

        if (fileStat.size !== this.size) {
            throw new iCPSError(LIBRARY_ERR.ASSET_SIZE)
                .addMessage(`${filePath} size ${fileStat.size}, iCloud ${this.size}`);
        }

        if (!this.withinRange(fileStat.mtimeMs, this.modified, 1000)) {
            throw new iCPSError(LIBRARY_ERR.ASSET_MODIFICATION_TIME)
                .addMessage(`${filePath} modification time ${fileStat.mtimeMs}, iCloud ${this.modified}`)
                .addContext(`out-of-range`, fileStat.mtimeMs - this.modified);
        }

        const localChecksum = await AssetChecksum.forFile(filePath);
        if (localChecksum !== this.fileChecksum) {
            throw new iCPSError(LIBRARY_ERR.ASSET_CHECKSUM)
                .addMessage(`${filePath} checksum ${localChecksum}, iCloud ${this.fileChecksum}`);
        }

        return true;
    }

    /**
     * Checks if one number is within the range of another number
     * @param x - One number
     * @param y - Other number
     * @param range - Range to check
     * @returns true if within range, false otherwise
     */
    private withinRange(x: number, y: number, range: number): boolean {
        return x >= y - range
            && x <= y + range;
    }

    /**
     *
     * @returns A display name for this instance
     */
    getDisplayName(): string {
        return this.fileChecksum;
    }
}
