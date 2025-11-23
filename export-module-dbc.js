#!/usr/bin/env node

/**
 * Export DBCs from a specific module's dbc or dbc_source folder
 * Usage: node export-module-dbc.js [--module NAME] [--source SOURCE] [--dbc NAME] [--limit N]
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node export-module-dbc.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --module NAME    Module name (any module works - uses "module" from config.json if not specified)');
    console.log('  --source TYPE    DBC source: "dbc" or "dbc_source" (default: both)');
    console.log('  --dbc NAME       Export only this DBC file');
    console.log('  --limit N        Limit number of records per DBC');
    console.log('  --dry-run        Show what would be done without doing it');
    console.log('  --help           Show this help');
    console.log('');
    console.log('Examples:');
    console.log('  node export-module-dbc.js');
    console.log('  node export-module-dbc.js --module default');
    console.log('  node export-module-dbc.js --module cow-level --source dbc');
    console.log('  node export-module-dbc.js --module my-custom-module --dbc Spell');
    process.exit(0);
}

// Load config first to get default module
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
    console.error('Error: config.json not found!');
    console.error('Copy config.example.json to config.json and update settings.');
    process.exit(1);
}

const mainConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const moduleName = args.indexOf('--module') !== -1 ? args[args.indexOf('--module') + 1] : mainConfig.module;
const sourceType = args.indexOf('--source') !== -1 ? args[args.indexOf('--source') + 1] : 'both';
const singleDbc = args.indexOf('--dbc') !== -1 ? args[args.indexOf('--dbc') + 1] : null;
const limitIndex = args.indexOf('--limit');
const limit = limitIndex !== -1 && args[limitIndex + 1] ? parseInt(args[limitIndex + 1]) : null;
const dryRun = args.includes('--dry-run');

// Validate source type
if (!['dbc', 'dbc_source', 'both'].includes(sourceType)) {
    console.error('Error: --source must be "dbc", "dbc_source", or "both"');
    process.exit(1);
}

// Load schemas
const schemaPath = path.join(__dirname, 'dbc-schemas.json');
if (!fs.existsSync(schemaPath)) {
    console.error('Error: dbc-schemas.json not found!');
    console.error('Run: node parse-tswow-schemas.js');
    process.exit(1);
}

const schemas = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const config = mainConfig.mysql;

// Build paths (supports any module name)
const tswowInstallPath = mainConfig.tswowInstallPath || path.join(__dirname, '..', '..');
const moduleBasePath = path.join(__dirname, tswowInstallPath, 'modules', moduleName, 'datasets', 'dataset');
const dbcPath = path.join(moduleBasePath, 'dbc');
const dbcSourcePath = path.join(moduleBasePath, 'dbc_source');

// Check module exists
if (!fs.existsSync(moduleBasePath)) {
    console.error(`Error: Module "${moduleName}" not found at: ${moduleBasePath}`);
    console.error('Any module name works - all modules have the same internal structure.');
    process.exit(1);
}

// Import the exporter logic from export-to-mysql-schema.js
function readDbc(dbcFilePath, schema) {
    const buffer = fs.readFileSync(dbcFilePath);

    const header = buffer.toString('ascii', 0, 4);
    if (header !== 'WDBC') throw new Error(`Invalid DBC header: ${header}`);

    const recordCount = buffer.readInt32LE(4);
    const fieldCount = buffer.readUInt32LE(8);
    const recordSize = buffer.readInt32LE(12);
    const stringSize = buffer.readInt32LE(16);

    const dataStart = 20;
    const stringTableStart = dataStart + (recordCount * recordSize);

    function readString(offset) {
        if (offset === 0) return '';
        const start = stringTableStart + offset;
        let end = start;
        while (end < buffer.length && buffer[end] !== 0) end++;
        return buffer.toString('utf8', start, end);
    }

    function readFieldValue(recordOffset, byteOffset, fieldType) {
        const offset = recordOffset + byteOffset;
        if (fieldType === 'float') return buffer.readFloatLE(offset);
        if (fieldType === 'string') return readString(buffer.readInt32LE(offset));
        if (fieldType === 'ulong') return Number(buffer.readBigUInt64LE(offset));
        if (fieldType === 'byte') return buffer.readUInt8(offset);
        return buffer.readInt32LE(offset);
    }

    const records = [];
    const actualLimit = limit !== null ? Math.min(limit, recordCount) : recordCount;
    
    for (let i = 0; i < actualLimit; i++) {
        const recordOffset = dataStart + (i * recordSize);
        const record = {};

        for (const field of schema.fields) {
            if (field.isArray) {
                const values = [];
                for (let j = 0; j < field.count; j++) {
                    const byteOffset = field.offset + (j * field.bytesPerField);
                    values.push(readFieldValue(recordOffset, byteOffset, field.type));
                }
                
                if (field.type === 'string' && field.count > 1) {
                    record[field.name] = values[0];
                } else {
                    for (let j = 0; j < field.count; j++) {
                        record[`${field.name}_${j + 1}`] = values[j];
                    }
                }
            } else {
                record[field.name] = readFieldValue(recordOffset, field.offset, field.type);
            }
        }
        
        records.push(record);
    }

    return {
        metadata: { recordCount, fieldCount, recordSize, stringSize, recordsShown: records.length },
        records
    };
}

function sanitizeTableName(name) {
    return name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}

function sanitizeColumnName(name) {
    const reserved = ['order', 'group', 'desc', 'key', 'name', 'type', 'index', 'range'];
    const sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_');
    return reserved.includes(sanitized.toLowerCase()) ? `\`${sanitized}\`` : sanitized;
}

function createTableSchema(tableName, schema) {
    const columns = [];
    
    for (const field of schema.fields) {
        const colName = sanitizeColumnName(field.name);
        
        if (field.name === 'ID') {
            columns.push(`${colName} INT PRIMARY KEY`);
        } else if (field.isArray) {
            if (field.type === 'string' && field.count > 1) {
                columns.push(`${colName} VARCHAR(255)`);
            } else {
                for (let i = 0; i < field.count; i++) {
                    const arrayColName = sanitizeColumnName(`${field.name}_${i + 1}`);
                    if (field.type === 'float') {
                        columns.push(`${arrayColName} FLOAT`);
                    } else if (field.type === 'byte') {
                        columns.push(`${arrayColName} TINYINT UNSIGNED`);
                    } else {
                        columns.push(`${arrayColName} INT`);
                    }
                }
            }
        } else if (field.type === 'float') {
            columns.push(`${colName} FLOAT`);
        } else if (field.type === 'string') {
            columns.push(`${colName} VARCHAR(255)`);
        } else if (field.type === 'ulong') {
            columns.push(`${colName} BIGINT UNSIGNED`);
        } else if (field.type === 'byte') {
            columns.push(`${colName} TINYINT UNSIGNED`);
        } else {
            columns.push(`${colName} INT`);
        }
    }

    return `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${columns.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
}

async function exportDbc(connection, dbcName, schema, dbcFolder, database) {
    const dbcFilePath = path.join(dbcFolder, `${dbcName}.dbc`);
    
    if (!fs.existsSync(dbcFilePath)) {
        return { dbcName, success: false, error: `File not found: ${dbcFilePath}`, database };
    }

    console.log(`\n[${database}.${dbcName}] Reading DBC file...`);
    
    try {
        const data = readDbc(dbcFilePath, schema);
        const tableName = sanitizeTableName(dbcName);
        
        console.log(`[${database}.${dbcName}] Records: ${data.metadata.recordCount}, Fields: ${schema.fields.length}`);
        console.log(`[${database}.${dbcName}] Exporting ${data.records.length} records to table: ${tableName}`);

        if (dryRun) {
            console.log(`[${database}.${dbcName}] DRY RUN - would create table and insert ${data.records.length} records`);
            return { dbcName, success: true, records: data.records.length, database };
        }

        const createTableSql = createTableSchema(tableName, schema);
        await connection.execute(`DROP TABLE IF EXISTS ${tableName}`);
        await connection.execute(createTableSql);
        console.log(`[${database}.${dbcName}] Table created`);

        const batchSize = 1000;
        let inserted = 0;

        for (let i = 0; i < data.records.length; i += batchSize) {
            const batch = data.records.slice(i, i + batchSize);
            
            for (const record of batch) {
                const fields = Object.keys(record).map(sanitizeColumnName);
                const values = Object.values(record);
                
                const placeholders = fields.map(() => '?').join(', ');
                const insertSql = `INSERT INTO ${tableName} (${fields.join(', ')}) VALUES (${placeholders})`;
                
                try {
                    await connection.execute(insertSql, values);
                    inserted++;
                } catch (err) {
                    if (err.code !== 'ER_DUP_ENTRY') {
                        console.error(`[${database}.${dbcName}] Insert error:`, err.message);
                    }
                }
            }

            if (batch.length > 0) {
                const progress = Math.min(i + batchSize, data.records.length);
                process.stdout.write(`\r[${database}.${dbcName}] Inserted ${progress}/${data.records.length} records...`);
            }
        }

        console.log(`\n[${database}.${dbcName}] ✓ Complete - ${inserted} records inserted`);
        return { dbcName, success: true, records: inserted, database };

    } catch (error) {
        console.error(`[${database}.${dbcName}] ✗ Error:`, error.message);
        return { dbcName, success: false, error: error.message, database };
    }
}

async function main() {
    console.log('=== Module DBC Export Tool ===\n');
    console.log(`Module: ${moduleName}`);
    console.log(`Source: ${sourceType}`);
    
    if (dryRun) console.log('*** DRY RUN MODE ***\n');

    // Determine which sources to export
    const sources = [];
    if (sourceType === 'dbc' || sourceType === 'both') {
        if (fs.existsSync(dbcPath)) {
            sources.push({ folder: dbcPath, database: 'dbc', name: 'dbc' });
        } else {
            console.log(`Warning: dbc folder not found: ${dbcPath}`);
        }
    }
    if (sourceType === 'dbc_source' || sourceType === 'both') {
        if (fs.existsSync(dbcSourcePath)) {
            sources.push({ folder: dbcSourcePath, database: 'dbc_source', name: 'dbc_source' });
        } else {
            console.log(`Warning: dbc_source folder not found: ${dbcSourcePath}`);
        }
    }

    if (sources.length === 0) {
        console.error('Error: No valid DBC folders found');
        process.exit(1);
    }

    // Get list of DBCs to export
    let dbcFiles;
    if (singleDbc) {
        if (!schemas[singleDbc]) {
            console.error(`Error: No schema found for ${singleDbc}`);
            process.exit(1);
        }
        dbcFiles = [singleDbc];
    } else {
        dbcFiles = Object.keys(schemas).sort();
    }

    console.log(`DBCs to process: ${dbcFiles.length}`);
    console.log(`Sources: ${sources.map(s => s.name).join(', ')}`);
    if (limit) console.log(`Record limit: ${limit} per DBC`);

    // Connect to database
    let connection;
    try {
        console.log(`\nConnecting to MySQL at ${config.host}:${config.port}...`);
        const configWithoutDb = { ...config };
        delete configWithoutDb.database;
        connection = await mysql.createConnection(configWithoutDb);
        console.log('Connected to MySQL');
    } catch (error) {
        console.error('Failed to connect to MySQL:', error.message);
        process.exit(1);
    }

    // Export each source
    const allResults = [];
    const startTime = Date.now();

    for (const source of sources) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Exporting from: ${source.name} (${source.folder})`);
        console.log(`Database: ${source.database}`);
        console.log(`${'='.repeat(60)}`);

        // Create database if it doesn't exist and switch to it
        if (!dryRun) {
            await connection.query(`CREATE DATABASE IF NOT EXISTS ${source.database}`);
            await connection.query(`USE ${source.database}`);
        }

        for (const dbcName of dbcFiles) {
            const schema = schemas[dbcName];
            const result = await exportDbc(connection, dbcName, schema, source.folder, source.database);
            allResults.push(result);
        }
    }

    // Summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const successful = allResults.filter(r => r.success).length;
    const totalRecords = allResults.reduce((sum, r) => sum + (r.records || 0), 0);

    console.log('\n' + '='.repeat(60));
    console.log('=== Export Summary ===');
    console.log(`Module: ${moduleName}`);
    console.log(`Total DBCs processed: ${allResults.length}`);
    console.log(`Successful: ${successful}`);
    console.log(`Failed: ${allResults.length - successful}`);
    console.log(`Total records: ${totalRecords}`);
    console.log(`Time: ${elapsed}s`);

    if (allResults.some(r => !r.success)) {
        console.log('\nFailed DBCs:');
        allResults.filter(r => !r.success).forEach(r => {
            console.log(`  - ${r.database}.${r.dbcName}: ${r.error || 'Unknown error'}`);
        });
    }

    await connection.end();
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

