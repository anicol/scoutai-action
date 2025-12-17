import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
import * as fs from 'fs';
import * as path from 'path';
import {
  CodebaseContext,
  TypeFile,
  SchemaFiles,
  TestPatterns,
  ChangedFile,
  FileDependency,
} from '../api/client';

const MAX_FILE_SIZE = 50 * 1024; // 50KB per file
const MAX_TOTAL_TYPES_SIZE = 500 * 1024; // 500KB total for types
const MAX_SCHEMA_SIZE = 100 * 1024; // 100KB per schema
const MAX_TEST_SAMPLES = 5;
const MAX_TEST_FILE_SIZE = 20 * 1024; // 20KB per test file

/**
 * Detect the primary language and framework from the project
 */
async function detectProjectType(): Promise<{
  language: string;
  framework?: string;
  test_framework?: string;
  package_json?: object;
}> {
  // Check for package.json (Node.js/TypeScript)
  if (fs.existsSync('package.json')) {
    try {
      const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

      let language = 'javascript';
      if (deps['typescript'] || fs.existsSync('tsconfig.json')) {
        language = 'typescript';
      }

      let framework: string | undefined;
      if (deps['react'] || deps['react-dom']) framework = 'react';
      else if (deps['vue']) framework = 'vue';
      else if (deps['@angular/core']) framework = 'angular';
      else if (deps['next']) framework = 'nextjs';
      else if (deps['express']) framework = 'express';
      else if (deps['fastify']) framework = 'fastify';
      else if (deps['@nestjs/core']) framework = 'nestjs';

      let test_framework: string | undefined;
      if (deps['jest'] || deps['@jest/core']) test_framework = 'jest';
      else if (deps['vitest']) test_framework = 'vitest';
      else if (deps['mocha']) test_framework = 'mocha';
      else if (deps['@playwright/test']) test_framework = 'playwright';

      return { language, framework, test_framework, package_json: packageJson };
    } catch (error) {
      core.debug(`Failed to parse package.json: ${error}`);
    }
  }

  // Check for Python projects
  if (fs.existsSync('pyproject.toml') || fs.existsSync('setup.py') || fs.existsSync('requirements.txt')) {
    let framework: string | undefined;
    let test_framework: string | undefined;

    // Check for Django
    if (fs.existsSync('manage.py')) {
      framework = 'django';
    }

    // Check requirements for framework hints
    const reqFiles = ['requirements.txt', 'requirements-dev.txt', 'pyproject.toml'];
    for (const reqFile of reqFiles) {
      if (fs.existsSync(reqFile)) {
        try {
          const content = fs.readFileSync(reqFile, 'utf-8').toLowerCase();
          if (content.includes('flask')) framework = framework || 'flask';
          if (content.includes('fastapi')) framework = framework || 'fastapi';
          if (content.includes('pytest')) test_framework = 'pytest';
          if (content.includes('unittest')) test_framework = test_framework || 'unittest';
        } catch {
          // Ignore read errors
        }
      }
    }

    return { language: 'python', framework, test_framework };
  }

  // Check for Go projects
  if (fs.existsSync('go.mod')) {
    return { language: 'go', test_framework: 'go-test' };
  }

  // Check for Ruby projects
  if (fs.existsSync('Gemfile')) {
    let framework: string | undefined;
    let test_framework: string | undefined;

    try {
      const gemfile = fs.readFileSync('Gemfile', 'utf-8').toLowerCase();
      if (gemfile.includes('rails')) framework = 'rails';
      if (gemfile.includes('sinatra')) framework = framework || 'sinatra';
      if (gemfile.includes('rspec')) test_framework = 'rspec';
      if (gemfile.includes('minitest')) test_framework = test_framework || 'minitest';
    } catch {
      // Ignore read errors
    }

    return { language: 'ruby', framework, test_framework };
  }

  // Default
  return { language: 'unknown' };
}

/**
 * Collect type definition files based on glob patterns
 */
async function collectTypeFiles(patterns: string[]): Promise<TypeFile[]> {
  const typeFiles: TypeFile[] = [];
  let totalSize = 0;

  for (const pattern of patterns) {
    const globber = await glob.create(pattern, { followSymbolicLinks: false });
    const files = await globber.glob();

    for (const filePath of files) {
      // Skip node_modules and other common excludes
      if (filePath.includes('node_modules/') || filePath.includes('.git/')) {
        continue;
      }

      try {
        const stats = fs.statSync(filePath);
        if (stats.size > MAX_FILE_SIZE) {
          core.debug(`Skipping type file (too large): ${filePath}`);
          continue;
        }

        if (totalSize + stats.size > MAX_TOTAL_TYPES_SIZE) {
          core.debug(`Reached max total types size, stopping collection`);
          break;
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const relativePath = path.relative(process.cwd(), filePath);
        typeFiles.push({ path: relativePath, content });
        totalSize += stats.size;

        core.debug(`Collected type file: ${relativePath} (${stats.size} bytes)`);
      } catch (error) {
        core.debug(`Failed to read type file ${filePath}: ${error}`);
      }
    }
  }

  core.info(`Collected ${typeFiles.length} type files (${(totalSize / 1024).toFixed(1)}KB)`);
  return typeFiles;
}

/**
 * Collect schema files (OpenAPI, GraphQL, Prisma, etc.)
 */
async function collectSchemas(patterns: string[]): Promise<SchemaFiles> {
  const schemas: SchemaFiles = {};

  for (const pattern of patterns) {
    const globber = await glob.create(pattern, { followSymbolicLinks: false });
    const files = await globber.glob();

    for (const filePath of files) {
      if (filePath.includes('node_modules/') || filePath.includes('.git/')) {
        continue;
      }

      try {
        const stats = fs.statSync(filePath);
        if (stats.size > MAX_SCHEMA_SIZE) {
          core.debug(`Skipping schema file (too large): ${filePath}`);
          continue;
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const fileName = path.basename(filePath).toLowerCase();

        if (fileName.includes('openapi') || fileName.includes('swagger')) {
          if (fileName.endsWith('.json')) {
            schemas.openapi = JSON.parse(content);
          } else if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) {
            // Store as string, backend can parse YAML
            schemas.openapi = { _yaml: content } as unknown as object;
          }
          core.info(`Collected OpenAPI schema: ${filePath}`);
        } else if (fileName.endsWith('.graphql') || fileName.endsWith('.gql')) {
          schemas.graphql = content;
          core.info(`Collected GraphQL schema: ${filePath}`);
        } else if (fileName === 'schema.prisma') {
          schemas.prisma = content;
          core.info(`Collected Prisma schema: ${filePath}`);
        }
      } catch (error) {
        core.debug(`Failed to read schema file ${filePath}: ${error}`);
      }
    }
  }

  return schemas;
}

/**
 * Collect sample test files and test configuration
 */
async function collectTestPatterns(testFramework?: string): Promise<TestPatterns> {
  const patterns: TestPatterns = {
    sample_tests: [],
    config: undefined,
    fixtures: [],
  };

  // Find test files based on common patterns
  const testGlobs = [
    '**/*.test.ts',
    '**/*.test.tsx',
    '**/*.spec.ts',
    '**/*.spec.tsx',
    '**/*.test.js',
    '**/*.spec.js',
    '**/test_*.py',
    '**/*_test.py',
    '**/tests/**/*.py',
    '**/*_test.go',
  ];

  const testFiles: string[] = [];

  for (const pattern of testGlobs) {
    const globber = await glob.create(pattern, { followSymbolicLinks: false });
    const files = await globber.glob();

    for (const file of files) {
      if (!file.includes('node_modules/') && !file.includes('.git/')) {
        testFiles.push(file);
      }
    }
  }

  // Sort by modification time (most recent first) and take samples
  const sortedFiles = testFiles
    .map(f => ({ path: f, mtime: fs.statSync(f).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_TEST_SAMPLES);

  for (const { path: filePath } of sortedFiles) {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size > MAX_TEST_FILE_SIZE) {
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(process.cwd(), filePath);
      patterns.sample_tests.push({ path: relativePath, content });
      core.debug(`Collected sample test: ${relativePath}`);
    } catch (error) {
      core.debug(`Failed to read test file ${filePath}: ${error}`);
    }
  }

  core.info(`Collected ${patterns.sample_tests.length} sample test files`);

  // Collect test config files
  const configFiles = [
    'jest.config.js',
    'jest.config.ts',
    'jest.config.json',
    'vitest.config.ts',
    'vitest.config.js',
    'pytest.ini',
    'pyproject.toml',
    'setup.cfg',
  ];

  for (const configFile of configFiles) {
    if (fs.existsSync(configFile)) {
      try {
        const content = fs.readFileSync(configFile, 'utf-8');
        if (configFile.endsWith('.json')) {
          patterns.config = JSON.parse(content);
        } else {
          patterns.config = { _raw: content, _file: configFile };
        }
        core.info(`Collected test config: ${configFile}`);
        break; // Only need one config
      } catch (error) {
        core.debug(`Failed to read config ${configFile}: ${error}`);
      }
    }
  }

  return patterns;
}

/**
 * Get changed files with their full content
 */
async function getChangedFilesWithContent(
  baseSha: string,
  headSha: string
): Promise<ChangedFile[]> {
  const changedFiles: ChangedFile[] = [];

  // Get list of changed files
  let diffOutput = '';
  await exec.exec('git', ['diff', '--name-status', baseSha, headSha], {
    listeners: {
      stdout: (data: Buffer) => {
        diffOutput += data.toString();
      },
    },
    silent: true,
  });

  const lines = diffOutput.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    const [status, ...pathParts] = line.split('\t');
    const filePath = pathParts.join('\t'); // Handle paths with tabs

    if (!filePath) continue;

    // Skip binary files and large files
    const fullPath = path.join(process.cwd(), filePath);
    if (!fs.existsSync(fullPath) && status !== 'D') continue;

    let fileStatus: 'added' | 'modified' | 'deleted';
    if (status === 'A') fileStatus = 'added';
    else if (status === 'D') fileStatus = 'deleted';
    else fileStatus = 'modified';

    const changedFile: ChangedFile = {
      path: filePath,
      status: fileStatus,
      content: '',
    };

    // Get current content for non-deleted files
    if (fileStatus !== 'deleted') {
      try {
        const stats = fs.statSync(fullPath);
        if (stats.size < MAX_FILE_SIZE) {
          changedFile.content = fs.readFileSync(fullPath, 'utf-8');
        } else {
          core.debug(`Skipping large changed file: ${filePath}`);
          continue;
        }
      } catch (error) {
        core.debug(`Failed to read changed file ${filePath}: ${error}`);
        continue;
      }
    }

    // Get previous content for modified files
    if (fileStatus === 'modified') {
      try {
        let previousContent = '';
        await exec.exec('git', ['show', `${baseSha}:${filePath}`], {
          listeners: {
            stdout: (data: Buffer) => {
              previousContent += data.toString();
            },
          },
          silent: true,
          ignoreReturnCode: true,
        });
        changedFile.previous_content = previousContent;
      } catch (error) {
        core.debug(`Failed to get previous content for ${filePath}: ${error}`);
      }
    }

    changedFiles.push(changedFile);
  }

  core.info(`Collected content for ${changedFiles.length} changed files`);
  return changedFiles;
}

/**
 * Build a simple import graph for changed files
 */
async function buildImportGraph(changedFiles: ChangedFile[]): Promise<FileDependency[]> {
  const dependencies: FileDependency[] = [];

  for (const file of changedFiles) {
    if (file.status === 'deleted' || !file.content) continue;

    const imports: string[] = [];

    // Extract imports based on file type
    const ext = path.extname(file.path);

    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      // JavaScript/TypeScript imports
      const importMatches = file.content.matchAll(
        /import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g
      );
      for (const match of importMatches) {
        imports.push(match[1]);
      }

      const requireMatches = file.content.matchAll(
        /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
      );
      for (const match of requireMatches) {
        imports.push(match[1]);
      }
    } else if (ext === '.py') {
      // Python imports
      const importMatches = file.content.matchAll(
        /^(?:from\s+(\S+)\s+)?import\s+(\S+)/gm
      );
      for (const match of importMatches) {
        imports.push(match[1] || match[2]);
      }
    } else if (ext === '.go') {
      // Go imports
      const importMatches = file.content.matchAll(
        /import\s+(?:\(\s*)?"([^"]+)"/g
      );
      for (const match of importMatches) {
        imports.push(match[1]);
      }
    }

    dependencies.push({
      file: file.path,
      imports: [...new Set(imports)], // Dedupe
      imported_by: [], // Would need full codebase scan
    });
  }

  return dependencies;
}

/**
 * Collect full codebase context for Scout Test
 */
export async function collectCodebaseContext(
  typePatterns: string[],
  schemaPatterns: string[],
  baseSha: string,
  headSha: string
): Promise<CodebaseContext> {
  core.info('Collecting codebase context for Scout Test...');

  // Detect project type
  const project = await detectProjectType();
  core.info(`Detected: ${project.language}${project.framework ? ` (${project.framework})` : ''}`);
  if (project.test_framework) {
    core.info(`Test framework: ${project.test_framework}`);
  }

  // Collect types
  const types = await collectTypeFiles(typePatterns);

  // Collect schemas
  const schemas = await collectSchemas(schemaPatterns);

  // Collect test patterns
  const test_patterns = await collectTestPatterns(project.test_framework);

  // Get changed files with content
  const changedFiles = await getChangedFilesWithContent(baseSha, headSha);

  // Build import graph
  const dependencies = await buildImportGraph(changedFiles);

  const context: CodebaseContext = {
    project,
    types,
    schemas,
    test_patterns,
    diff: {
      files: changedFiles,
      base_sha: baseSha,
      head_sha: headSha,
    },
    dependencies,
  };

  // Log context size
  const contextJson = JSON.stringify(context);
  core.info(`Total context size: ${(contextJson.length / 1024).toFixed(1)}KB`);

  return context;
}
