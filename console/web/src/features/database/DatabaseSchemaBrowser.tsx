import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search, SquareTerminal, X } from "lucide-react";
import { databaseApi } from "../../api/database";

type DatabaseTable = Record<string, unknown>;
type DatabaseColumn = Record<string, unknown>;

type DatabaseSchemaBrowserProps = {
  schema: string;
  tables: DatabaseTable[];
  onCreateQuery: (query: string) => void;
};

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedIdentifier(schema: string, table: string) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function DatabaseSchemaBrowser({ schema, tables, onCreateQuery }: DatabaseSchemaBrowserProps) {
  const [filter, setFilter] = useState("");
  const [expandedTable, setExpandedTable] = useState("");
  const [columnsByTable, setColumnsByTable] = useState<Record<string, DatabaseColumn[]>>({});
  const [loadingTable, setLoadingTable] = useState("");
  const [errorsByTable, setErrorsByTable] = useState<Record<string, string>>({});
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredTables = useMemo(() => {
    if (!normalizedFilter) return tables;
    return tables.filter((table) => {
      const tableName = String(table.name || "");
      const columns = columnsByTable[tableName] || [];
      return `${String(table.schema || schema)}.${tableName}`.toLowerCase().includes(normalizedFilter)
        || columns.some((column) => String(column.name || "").toLowerCase().includes(normalizedFilter));
    });
  }, [columnsByTable, normalizedFilter, schema, tables]);

  async function toggleTable(tableName: string) {
    if (expandedTable === tableName) {
      setExpandedTable("");
      return;
    }
    setExpandedTable(tableName);
    if (columnsByTable[tableName]) return;
    setLoadingTable(tableName);
    setErrorsByTable((current) => ({ ...current, [tableName]: "" }));
    try {
      const nextColumns = await databaseApi.columns(schema, tableName);
      setColumnsByTable((current) => ({ ...current, [tableName]: nextColumns }));
    } catch (error) {
      setErrorsByTable((current) => ({
        ...current,
        [tableName]: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      setLoadingTable((current) => current === tableName ? "" : current);
    }
  }

  return <section className="database-schema-browser" aria-label="Table schemas">
    <div className="database-schema-filter">
      <Search size={17} aria-hidden="true" />
      <input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter table or loaded column names"
        aria-label="Filter table schemas"
      />
      {filter && <button className="icon-button" onClick={() => setFilter("")} title="Clear schema filter" aria-label="Clear schema filter"><X size={17} /></button>}
    </div>
    <div className="database-schema-list">
      <div className="database-schema-table-header" aria-hidden="true">
        <span />
        <span>Table</span>
        <span>Rows</span>
        <span />
      </div>
      {filteredTables.map((table) => {
        const tableSchema = String(table.schema || schema);
        const tableName = String(table.name || "");
        const isExpanded = expandedTable === tableName;
        const columns = columnsByTable[tableName] || [];
        const error = errorsByTable[tableName];
        return <div className="database-schema-table" key={`${tableSchema}.${tableName}`}>
          <div className="database-schema-table-row">
            <button
              className="icon-button"
              onClick={() => void toggleTable(tableName)}
              title={isExpanded ? `Collapse ${tableName}` : `Show columns for ${tableName}`}
              aria-label={isExpanded ? `Collapse ${tableName}` : `Show columns for ${tableName}`}
              aria-expanded={isExpanded}
            >
              {isExpanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
            </button>
            <code>{tableSchema}.{tableName}</code>
            <span>{String(table.row_count ?? "")}</span>
            <button
              className="icon-button"
              onClick={() => onCreateQuery(`SELECT *\nFROM ${qualifiedIdentifier(tableSchema, tableName)}\nLIMIT 25;`)}
              title={`Create query for ${tableSchema}.${tableName}`}
              aria-label={`Create query for ${tableSchema}.${tableName}`}
            ><SquareTerminal size={17} /></button>
          </div>
          {isExpanded && <div className="database-schema-columns">
            <div className="database-schema-column-header" aria-hidden="true">
              <span>Column</span>
              <span>Type</span>
              <span>Null</span>
              <span>Default</span>
              <span />
            </div>
            {loadingTable === tableName && <div className="database-schema-message">Loading columns...</div>}
            {error && <div className="database-schema-message danger-note">{error}</div>}
            {!error && loadingTable !== tableName && columns.length === 0 && <div className="database-schema-message">No columns found.</div>}
            {columns.map((column) => {
              const columnName = String(column.name || "");
              const nullable = String(column.is_nullable || "").toUpperCase() === "YES";
              const defaultValue = column.column_default === null || column.column_default === undefined
                ? ""
                : String(column.column_default);
              return <div className="database-schema-column-row" key={columnName}>
                <code>{columnName}</code>
                <span>{String(column.data_type || "")}</span>
                <span>{nullable ? "Nullable" : "Required"}</span>
                <code title={defaultValue}>{defaultValue || "-"}</code>
                <button
                  className="icon-button"
                  onClick={() => onCreateQuery(`SELECT ${quoteIdentifier(columnName)}\nFROM ${qualifiedIdentifier(tableSchema, tableName)}\nLIMIT 25;`)}
                  title={`Create query for ${columnName}`}
                  aria-label={`Create query for ${columnName}`}
                ><SquareTerminal size={16} /></button>
              </div>;
            })}
          </div>}
        </div>;
      })}
      {filteredTables.length === 0 && <div className="database-schema-message">No matching tables found.</div>}
    </div>
  </section>;
}
