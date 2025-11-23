# tswow-module-dbcs-to-mysql

Bulk export TSWoW module's source and dest DBC files to a MySQL database.

Rather than being a part of development workflow (like https://github.com/stoneharry/DBC-Editing-Workflow), this is to enable AI to better understand DBC structure so that the AI can then return back to TSWoW tools for creating spells in Livescripts and Datascripts. This tool also works well with TSWoW's module structure.

## Quick Start - Bulk Export to MySQL

### 1. Compile TSWoW from source

Follow the official guide: https://tswow.github.io/tswow-wiki/install/compiling

### 2. Use git to clone this repository

### 3. Install dependencies

```bash
npm install
```

### 4. Configure settings

Copy the example config and update with your settings:

```bash
cp config.example.json config.json
# Edit config.json with your MySQL credentials and default module
```

**config.json:**
```json
{
  "mysql": {
    "host": "localhost",
    "port": 3306,
    "user": "tswow",
    "password": "password"
  },
  "module": "default",
  "tswowInstallPath": "c:\\wowdev\\tswow-install",
  "tswowSourcePath": "c:\\wowdev\\tswow"
}
```

**Notes:**
- MySQL user needs CREATE, DROP, INSERT, and SELECT permissions
- `module` can be **any parent module** as defined in [TSWoW Modules documentation](https://tswow.github.io/tswow-wiki/documentation/modules.html)
  - Examples: "default"
  - Assumption: All parent modules have the same internal structure: `modules/{name}/datasets/dataset/dbc/` and `dbc_source/`

### 5. Generate schemas from TSWoW (one-time)

```bash
node parse-tswow-schemas.js
```

This reads all TSWoW DBC definitions and creates `dbc-schemas.json` with proper field names and types for all 246 DBCs.

### 6. Export DBCs to MySQL

```bash
# Export from default module (both dbc and dbc_source)
node export-module-dbc.js

# Export only post-TSWoW DBCs
node export-module-dbc.js --source dbc

# Export only original Blizzard DBCs
node export-module-dbc.js --source dbc_source

# Export from ANY module (just use the module name)
node export-module-dbc.js --module my-custom-module

# Export just one DBC for testing
node export-module-dbc.js --dbc Spell --limit 100

# Dry run to see what would happen
node export-module-dbc.js --dry-run
```

This will create the `dbc` and `dbc_source` databases and import all 246 DBC files as tables with **proper column names**!

## How It Works

### DBC Reader

The read-dbc.js script:
1. Reads the binary DBC file
2. Parses the WDBC header (magic, record count, field count, etc.)
3. Reads all records from the data section
4. Auto-detects string fields and reads them from the string table
5. Outputs the data as JSON

### MySQL Exporter

The export-to-mysql.js script:
1. Scans the dbc_source folder for all DBC files
2. Reads each DBC using the same parser as read-dbc.js
3. Creates a MySQL table for each DBC (drops if exists)
4. Auto-detects string fields and creates appropriate VARCHAR columns
5. Inserts all records in batches for performance
6. Creates primary key on field_0 (usually the ID field)

**Table naming:** DBC names are sanitized (e.g., `Achievement_Category.dbc` → `achievement_category` table)

## DBC File Format

```
Header (20 bytes):
- "WDBC" magic (4 bytes)
- Record count (4 bytes, int32)
- Field count (4 bytes, uint32)
- Record size (4 bytes, int32)
- String size (4 bytes, int32)

Data:
- Record data (recordCount * recordSize bytes)
- String table (stringSize bytes, null-terminated strings)
```

## Files

- `parse-tswow-schemas.js` - Extract field schemas from TSWoW TypeScript definitions
- `read-dbc-schema.js` - Read DBC files as JSON with proper field names
- `export-module-dbc.js` - Export DBCs to MySQL (both dbc and dbc_source)
- `dbc-schemas.json` - Generated schema definitions for all 246 DBCs
- `config.json` - MySQL credentials and default module