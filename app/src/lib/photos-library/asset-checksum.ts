import {createHash} from 'crypto';
import {createReadStream} from 'fs';
import {pEvent} from 'p-event';

const CLOUDKIT_FILE_CHECKSUM_VERSION = 0x01;
const CLOUDKIT_FILE_CHECKSUM_SALT = Buffer.from(`com.apple.XattrObjectSalt\0com.apple.DataObjectSalt\0`, `utf8`);

/**
 * Computes Apple's CloudKit/MMCS file checksum for Photos asset bytes.
 */
export class AssetChecksum {
    /**
     * Computes a CloudKit file checksum for an in-memory buffer.
     * @param data - File bytes
     * @returns Base64 encoded checksum in iCloud's 0x01 + SHA1 digest format
     */
    static forBuffer(data: Buffer): string {
        const digest = createHash(`sha1`)
            .update(CLOUDKIT_FILE_CHECKSUM_SALT)
            .update(data)
            .digest();

        return AssetChecksum.formatDigest(digest);
    }

    /**
     * Computes a CloudKit file checksum for a file on disk.
     * @param filePath - File path to hash
     * @returns Base64 encoded checksum in iCloud's 0x01 + SHA1 digest format
     */
    static async forFile(filePath: string): Promise<string> {
        const hash = createHash(`sha1`);
        hash.update(CLOUDKIT_FILE_CHECKSUM_SALT);

        const stream = createReadStream(filePath);
        stream.on(`data`, chunk => hash.update(chunk));
        await pEvent(stream, `end`, {rejectionEvents: [`error`]});

        return AssetChecksum.formatDigest(hash.digest());
    }

    private static formatDigest(digest: Buffer): string {
        return Buffer.concat([
            Buffer.from([CLOUDKIT_FILE_CHECKSUM_VERSION]),
            digest,
        ]).toString(`base64`);
    }
}
