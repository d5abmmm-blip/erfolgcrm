/* Connectivity spike: can Node read the Firebird 2.5 base + correct Cyrillic? */
const Firebird = require('node-firebird');

const options = {
  host: '127.0.0.1',
  port: 3050,
  database: process.env.FDB_PATH || 'D:\\работаа\\WinServisePro\\data_work.fdb',
  user: 'SYSDBA',
  password: 'masterkey',
  lowercase_keys: false,
  encoding: 'UTF8',
};

Firebird.attach(options, (err, db) => {
  if (err) {
    console.error('ATTACH FAILED:', err.message || err);
    process.exit(1);
  }
  db.query(
    'SELECT FIRST 5 ID, DESCRIPTION, CLIENTTYPE, ISGROUP, INN, MOBILEPHONE FROM CLIENT ORDER BY ID',
    [],
    (err2, rows) => {
      if (err2) {
        console.error('QUERY FAILED:', err2.message || err2);
        db.detach();
        process.exit(1);
      }
      console.log('OK — sample CLIENT rows:');
      for (const r of rows) {
        console.log(JSON.stringify(r));
      }
      db.detach();
    },
  );
});
