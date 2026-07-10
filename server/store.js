import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, id, listDirs, nowIso, readJson, rmrf, writeJsonAtomic } from './util.js';

export function createStore(workspace) {
	const root = workspace || process.env.FABMA_WORKSPACE || path.join(os.homedir(), 'Fabma');
	const projectsDir = ensureDir(path.join(root, 'projects'));
	const jobsDir = ensureDir(path.join(root, '.jobs'));

	const projectFile = (pid) => path.join(projectsDir, pid, 'project.json');
	const generationDir = (pid, gid) => path.join(projectsDir, pid, gid);
	const variantFile = (pid, gid, name) => path.join(generationDir(pid, gid), name);

	function listProjects() {
		return listDirs(projectsDir)
			.map((pid) => readJson(projectFile(pid)))
			.filter(Boolean)
			.map(({ id: pid, name, brief, mode, ephemeral, createdAt, generations }) => ({
				id: pid,
				name,
				brief,
				mode,
				ephemeral: !!ephemeral,
				createdAt,
				generationCount: generations.length,
				lastActivity: generations.at(-1)?.createdAt || createdAt,
			}))
			.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
	}

	function createProject({ name, brief, mode, ephemeral }) {
		const project = {
			id: id(10),
			name: String(name || 'Untitled').slice(0, 120),
			brief: String(brief || '').slice(0, 8000),
			mode: ['page', 'section', 'illustration'].includes(mode) ? mode : 'page',
			ephemeral: !!ephemeral,
			createdAt: nowIso(),
			generations: [],
		};
		ensureDir(path.join(projectsDir, project.id));
		writeJsonAtomic(projectFile(project.id), project);
		return project;
	}

	const getProject = (pid) => readJson(projectFile(pid));

	function saveProject(project) {
		writeJsonAtomic(projectFile(project.id), project);
		return project;
	}

	// Atomic read-modify-write for anything that mutates after an await.
	// Concurrent variant jobs each hold stale snapshots; this always applies
	// the mutation to the freshest disk state. `mutate` must be synchronous
	// and return null to skip saving.
	function updateProject(pid, mutate) {
		const project = getProject(pid);
		if (!project) return null;
		const result = mutate(project);
		if (result !== null) saveProject(project);
		return result;
	}

	function deleteProject(pid) {
		rmrf(path.join(projectsDir, pid));
	}

	function addGeneration(project, generation) {
		ensureDir(generationDir(project.id, generation.id));
		project.generations.push(generation);
		saveProject(project);
		return generation;
	}

	function deleteGeneration(project, gid) {
		project.generations = project.generations.filter((g) => g.id !== gid);
		saveProject(project);
		rmrf(generationDir(project.id, gid));
	}

	const findGeneration = (project, gid) => project.generations.find((g) => g.id === gid);

	function writeVariantFile(pid, gid, name, content) {
		const file = variantFile(pid, gid, name);
		fs.writeFileSync(file, content);
		return file;
	}

	// Mark work that was in flight when the server died.
	function recoverInterrupted() {
		for (const pid of listDirs(projectsDir)) {
			const project = readJson(projectFile(pid));
			if (!project) continue;
			let dirty = false;
			for (const gen of project.generations) {
				for (const variant of gen.variants) {
					if (variant.status === 'pending' || variant.status === 'running') {
						variant.status = 'error';
						variant.error = 'Interrupted by server restart';
						dirty = true;
					}
				}
				if (gen.status === 'running') {
					gen.status = gen.variants.some((v) => v.status === 'done') ? 'partial' : 'failed';
					dirty = true;
				}
			}
			if (dirty) saveProject(project);
		}
	}

	return {
		root,
		jobsDir,
		listProjects,
		createProject,
		getProject,
		saveProject,
		updateProject,
		deleteProject,
		addGeneration,
		deleteGeneration,
		findGeneration,
		generationDir,
		variantFile,
		writeVariantFile,
		recoverInterrupted,
	};
}
