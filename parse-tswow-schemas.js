#!/usr/bin/env node

/**
 * Parse TSWoW DBC schema files to extract field definitions
 * Reads .ts files from tswow-scripts/wotlk/dbc/ and generates schema JSON
 */

const fs = require('fs');
const path = require('path');

// Load config to get tswowSourcePath
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
    console.error('Error: config.json not found!');
    console.error('Copy config.example.json to config.json and update settings.');
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const tswowSourcePath = config.tswowSourcePath || path.join(__dirname, '..', '..', '..', 'tswow');

// Path to TSWoW DBC definitions
const tswowDbcPath = path.join(__dirname, tswowSourcePath, 'tswow-scripts', 'wotlk', 'dbc');
const outputPath = path.join(__dirname, 'dbc-schemas.json');

function parseDbcSchema(filePath, dbcName) {
    const content = fs.readFileSync(filePath, 'utf8');
    const fields = [];
    
    // Match getter definitions with offsets
    // Pattern: get FieldName() { return new DBCTypeCell(this,this.buffer,this.offset+NUMBER)}
    const getterRegex = /get\s+(\w+)\(\)\s*{\s*return\s+new\s+(DBC\w+Cell)\(this,(?:(\d+),)?this\.buffer,this\.offset\+(\d+)\)/g;
    
    let match;
    while ((match = getterRegex.exec(content)) !== null) {
        const fieldName = match[1];
        const cellType = match[2];
        const arraySize = match[3] ? parseInt(match[3]) : null;
        const offset = parseInt(match[4]);
        
        // Skip if it's just the ID field and we already have it
        if (fieldName === 'ID' && fields.length > 0) continue;
        
        // Determine field type from cell type
        let fieldType = 'int';
        let isArray = false;
        let count = 1;
        let bytesPerField = 4; // Default: 4 bytes per field
        
        if (cellType.includes('ULong')) {
            fieldType = 'ulong';
            bytesPerField = 8; // ULong is 8 bytes (64-bit)
        } else if (cellType.includes('ByteArray')) {
            fieldType = 'byte';
            isArray = true;
            count = arraySize || 1;
            bytesPerField = 1; // 1 byte per element
        } else if (cellType.includes('Byte')) {
            fieldType = 'byte';
            bytesPerField = 1; // 1 byte
        } else if (cellType.includes('IntArray') || cellType.includes('UIntArray') || cellType.includes('MultiArray')) {
            fieldType = 'int';
            isArray = true;
            count = arraySize || 1;
        } else if (cellType.includes('FloatArray')) {
            fieldType = 'float';
            isArray = true;
            count = arraySize || 1;
        } else if (cellType.includes('Float')) {
            fieldType = 'float';
        } else if (cellType.includes('Loc')) {
            fieldType = 'string';
            isArray = true;
            count = 17; // Localized strings have 16 language versions + 1 flags field
        } else if (cellType.includes('StringArray')) {
            fieldType = 'string';
            isArray = true;
            count = arraySize || 1;
        } else if (cellType.includes('String')) {
            fieldType = 'string';
        } else if (cellType.includes('Bool') || cellType.includes('Enum') || cellType.includes('Flag') || cellType.includes('Mask') || cellType.includes('Pointer')) {
            fieldType = 'int'; // These are all 4-byte int types
        } else if (cellType.includes('Key') || cellType.includes('Int') || cellType.includes('UInt')) {
            fieldType = 'int';
        }
        
        fields.push({
            name: fieldName,
            type: fieldType,
            offset: offset,
            isArray: isArray,
            count: count,
            cellType: cellType,
            bytesPerField: bytesPerField
        });
    }
    
    // Sort by offset to get correct field order
    fields.sort((a, b) => a.offset - b.offset);
    
    // Calculate total field count (in 4-byte units) by finding max offset + size
    let maxByteOffset = 0;
    fields.forEach(field => {
        const fieldEndByte = field.offset + (field.isArray ? (field.count * field.bytesPerField) : field.bytesPerField);
        if (fieldEndByte > maxByteOffset) {
            maxByteOffset = fieldEndByte;
        }
        
        // Field index is the byte offset divided by 4 (since DBC reads in 4-byte chunks)
        field.fieldIndex = Math.floor(field.offset / 4);
        
        if (field.isArray) {
            field.fieldIndices = [];
            if (field.bytesPerField === 1) {
                // Byte arrays: calculate which 4-byte chunk each byte falls into
                for (let i = 0; i < field.count; i++) {
                    const bytePos = field.offset + i;
                    field.fieldIndices.push(Math.floor(bytePos / 4));
                }
            } else {
                // Standard arrays (4 bytes per element)
                for (let i = 0; i < field.count; i++) {
                    field.fieldIndices.push(field.fieldIndex + i);
                }
            }
        } else if (field.bytesPerField === 8) {
            // ULong fields span 2 field indices
            field.fieldIndices = [field.fieldIndex, field.fieldIndex + 1];
        } else if (field.bytesPerField === 1) {
            // Single byte field - track which byte within the 4-byte chunk
            field.byteIndexInChunk = field.offset % 4;
        }
    });
    
    // Total fields is the max byte offset divided by 4 (rounded up)
    const totalFields = Math.ceil(maxByteOffset / 4);
    
    return {
        name: dbcName,
        totalFields: totalFields,
        fields: fields
    };
}

function parseAllSchemas() {
    console.log('Parsing TSWoW DBC schemas...\n');
    
    if (!fs.existsSync(tswowDbcPath)) {
        console.error(`Error: TSWoW DBC path not found: ${tswowDbcPath}`);
        console.error('Make sure the tswow repository is in the expected location.');
        process.exit(1);
    }
    
    const files = fs.readdirSync(tswowDbcPath)
        .filter(f => f.endsWith('.ts') && f !== 'Types.ts')
        .sort();
    
    const schemas = {};
    let parsed = 0;
    let skipped = 0;
    
    for (const file of files) {
        const dbcName = file.replace('.ts', '');
        const filePath = path.join(tswowDbcPath, file);
        
        try {
            const schema = parseDbcSchema(filePath, dbcName);
            
            if (schema.fields.length > 0) {
                schemas[dbcName] = schema;
                parsed++;
                
                if (parsed <= 5 || dbcName === 'Faction') {
                    console.log(`✓ ${dbcName}: ${schema.fields.length} fields (${schema.totalFields} total with arrays)`);
                }
            } else {
                skipped++;
            }
        } catch (error) {
            console.error(`✗ ${dbcName}: ${error.message}`);
            skipped++;
        }
    }
    
    if (parsed > 5 && !schemas['Faction']) {
        console.log(`  ... and ${parsed - 5} more`);
    }
    
    console.log(`\nParsed: ${parsed} schemas`);
    console.log(`Skipped: ${skipped} files`);
    
    // Write to JSON file
    fs.writeFileSync(outputPath, JSON.stringify(schemas, null, 2));
    console.log(`\n✓ Schemas saved to: ${outputPath}`);
    
    return schemas;
}

// Run if called directly
if (require.main === module) {
    parseAllSchemas();
}

module.exports = { parseAllSchemas, parseDbcSchema };

