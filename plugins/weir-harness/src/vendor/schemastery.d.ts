// Public surface of the vendored schema builder consumed by settings.
interface Schema {
  volatile(): Schema;
  description(text: string): Schema;
}
declare const schema: {
  string(): Schema;
  number(): Schema;
  boolean(): Schema;
  union(values: readonly string[]): Schema;
  object(fields: Readonly<Record<string, Schema>>): Schema;
};
export default schema;
