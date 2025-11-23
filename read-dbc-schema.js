#!/usr/bin/env node

/**
 * Schema-aware DBC reader - uses TSWoW field definitions
 * Usage: node read-dbc-schema.js <dbc-name> [--limit N]
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node read-dbc-schema.js <dbc-name> [--limit N]');
    console.log('');
    console.log('Examples:');
    console.log('  node read-dbc-schema.js Faction');
    console.log('  node read-dbc-schema.js Achievement_Category --limit 10');
    process.exit(0);
}

const dbcName = args[0];
const limitIndex = args.indexOf('--limit');
const limit = limitIndex !== -1 && args[limitIndex + 1] ? parseInt(args[limitIndex + 1]) : null;

// Load schema
const schemaPath = path.join(__dirname, 'dbc-schemas.json');
if (!fs.existsSync(schemaPath)) {
    console.error('Error: dbc-schemas.json not found!');
    console.error('Run: node parse-tswow-schemas.js');
    process.exit(1);
}

const schemas = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const schema = schemas[dbcName];

if (!schema) {
    console.error(`Error: No schema found for ${dbcName}`);
    console.error(`\nAvailable schemas: ${Object.keys(schemas).slice(0, 20).join(', ')}, ...`);
    process.exit(1);
}

// Read DBC file
const dbcSourcePath = path.join(__dirname, '..', '..', 'modules', 'default', 'datasets', 'dataset', 'dbc_source', `${dbcName}.dbc`);

if (!fs.existsSync(dbcSourcePath)) {
    console.error(`Error: DBC file not found: ${dbcSourcePath}`);
    process.exit(1);
}

const buffer = fs.readFileSync(dbcSourcePath);

// Parse DBC header
const header = buffer.toString('ascii', 0, 4);
if (header !== 'WDBC') {
    console.error(`Error: Invalid DBC header: ${header}`);
    process.exit(1);
}

const recordCount = buffer.readInt32LE(4);
const fieldCount = buffer.readUInt32LE(8);
const recordSize = buffer.readInt32LE(12);
const stringSize = buffer.readInt32LE(16);

// Calculate offsets
const dataStart = 20;
const dataEnd = dataStart + (recordCount * recordSize);
const stringTableStart = dataEnd;

// Helper function to read strings from the string table
function readString(offset) {
    if (offset === 0) return '';
    const start = stringTableStart + offset;
    let end = start;
    while (end < buffer.length && buffer[end] !== 0) {
        end++;
    }
    return buffer.toString('utf8', start, end);
}

// Helper function to read a field value based on type
function readFieldValue(recordOffset, byteOffset, fieldType) {
    const offset = recordOffset + byteOffset;
    
    if (fieldType === 'float') {
        return buffer.readFloatLE(offset);
    } else if (fieldType === 'string') {
        const stringOffset = buffer.readInt32LE(offset);
        return readString(stringOffset);
    } else if (fieldType === 'ulong') {
        // ULong is 8 bytes - read as BigInt
        return Number(buffer.readBigUInt64LE(offset));
    } else if (fieldType === 'byte') {
        // Byte is 1 byte
        return buffer.readUInt8(offset);
    } else {
        // int or default
        return buffer.readInt32LE(offset);
    }
}

// Read records using schema
const records = [];
for (let i = 0; i < recordCount; i++) {
    if (limit !== null && i >= limit) break;
    
    const recordOffset = dataStart + (i * recordSize);
    const record = {};
    
    for (const field of schema.fields) {
        if (field.isArray) {
            // Handle arrays (including localized strings)
            const values = [];
            for (let j = 0; j < field.count; j++) {
                const byteOffset = field.offset + (j * field.bytesPerField);
                const value = readFieldValue(recordOffset, byteOffset, field.type);
                values.push(value);
            }
            
            // For localized strings, only include non-empty first value (enUS)
            if (field.type === 'string' && field.count > 1) {
                record[field.name] = values[0]; // enUS locale
                // Optionally include all locales
                // record[`${field.name}_locales`] = values;
            } else {
                record[field.name] = values;
            }
        } else {
            // Single value - use actual byte offset from schema
            const value = readFieldValue(recordOffset, field.offset, field.type);
            record[field.name] = value;
        }
    }
    
    records.push(record);
}

// Output JSON
console.log(JSON.stringify({
    dbcName,
    schema: {
        totalFields: schema.totalFields,
        namedFields: schema.fields.length
    },
    metadata: {
        recordCount,
        fieldCount,
        recordSize,
        stringSize,
        recordsShown: records.length
    },
    records
}, null, 2));

