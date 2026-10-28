CREATE DATABASE reporting;
CREATE DATABASE reporting_empty;

CREATE TABLE reporting.fixture_rows (
  id INT PRIMARY KEY,
  label VARCHAR(40) NOT NULL
);
INSERT INTO reporting.fixture_rows VALUES (1, 'disposable fixture row');
CREATE VIEW reporting.fixture_view AS SELECT id, label FROM reporting.fixture_rows;

CREATE USER 'fixture_reader'@'%' IDENTIFIED BY 'disposable-reader-password';
GRANT SELECT, SHOW VIEW ON reporting.* TO 'fixture_reader'@'%';

CREATE USER 'fixture_writer'@'%' IDENTIFIED BY 'disposable-writer-password';
GRANT SELECT, INSERT ON reporting.* TO 'fixture_writer'@'%';

CREATE ROLE 'fixture_reporting_role'@'%';
GRANT SELECT, SHOW VIEW ON reporting.* TO 'fixture_reporting_role'@'%';
CREATE USER 'fixture_role_reader'@'%' IDENTIFIED BY 'disposable-role-password';
GRANT 'fixture_reporting_role'@'%' TO 'fixture_role_reader'@'%';
SET DEFAULT ROLE ALL TO 'fixture_role_reader'@'%';

CREATE USER 'fixture_empty_reader'@'%' IDENTIFIED BY 'disposable-empty-password';
GRANT SELECT, SHOW VIEW ON reporting_empty.* TO 'fixture_empty_reader'@'%';
