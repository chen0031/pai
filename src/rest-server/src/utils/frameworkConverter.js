const zlib = require('zlib');
const _ = require('lodash');
const axios = require('axios');
const {Agent} = require('https');
const yaml = require('js-yaml');

const logger = require('@pai/config/logger');
const launcherConfig = require('@pai/config/launcher');
const {apiserver} = require('@pai/config/kubernetes');
const k8s = require('@pai/utils/k8sUtils');

const decodeName = (name, labels) => {
  if (labels && labels.jobName) {
    return labels.jobName;
  } else {
    // framework name has not been encoded
    return name;
  }
};

const decompressField = (val) => {
  if (val == null) {
    return null;
  } else {
    return JSON.parse(zlib.gunzipSync(Buffer.from(val, 'base64')).toString());
  }
};

const convertState = (state, exitCode) => {
  switch (state) {
    case 'AttemptCreationPending':
    case 'AttemptCreationRequested':
    case 'AttemptPreparing':
      return 'WAITING';
    case 'AttemptRunning':
    case 'AttemptDeletionPending':
    case 'AttemptDeletionRequested':
    case 'AttemptDeleting':
      return 'RUNNING';
    case 'AttemptCompleted':
      if (exitCode === 0) {
        return 'SUCCEEDED';
      } else if (exitCode === -210 || exitCode === -220) {
        return 'STOPPED';
      } else {
        return 'FAILED';
      }
    case 'Completed':
      if (exitCode === 0) {
        return 'SUCCEEDED';
      } else if (exitCode === -210 || exitCode === -220) {
        return 'STOPPED';
      } else {
        return 'FAILED';
      }
    default:
      return 'UNKNOWN';
  }
};

const convertToJobAttempt = (framework) => {
  const completionStatus = framework.status.attemptStatus.completionStatus;
  const name = decodeName(framework.metadata.name, framework.metadata.labels);
  const frameworkName = framework.metadata.name;
  const username = framework.metadata.labels
    ? framework.metadata.labels.userName
    : 'unknown';
  const state = convertState(
    framework.status.state,
    completionStatus ? completionStatus.code : null,
    framework.status.retryPolicyStatus.retryDelaySec,
  );
  const originState = framework.status.state;
  const attemptIndex = framework.status.attemptStatus.id;
  const jobStartedTime = new Date(
    framework.metadata.creationTimestamp,
  ).getTime();
  const attemptStartedTime = new Date(
    framework.status.attemptStatus.startTime,
  ).getTime();
  const attemptCompletedTime = new Date(
    framework.status.attemptStatus.completionTime,
  ).getTime();
  const totalGpuNumber = framework.metadata.annotations
    ? framework.metadata.annotations.totalGpuNumber
    : 0;
  const totalTaskNumber = framework.spec.taskRoles.reduce(
    (num, spec) => num + spec.taskNumber,
    0,
  );
  const totalTaskRoleNumber = framework.spec.taskRoles.length;
  return {
    name,
    frameworkName,
    username,
    state,
    originState,
    attemptIndex,
    jobStartedTime,
    attemptStartedTime,
    attemptCompletedTime,
    totalGpuNumber,
    totalTaskNumber,
    totalTaskRoleNumber,
  };
};

const convertToJobAttemptDetail = async (framework, attemptIndex) => {
  // check fields which may be compressed
  if (framework.status.attemptStatus.taskRoleStatuses == null) {
    framework.status.attemptStatus.taskRoleStatuses = decompressField(
      framework.status.attemptStatus.taskRoleStatusesCompressed,
    );
  }

  const completionStatus = framework.status.attemptStatus.completionStatus;
  const diagnostics = completionStatus ? completionStatus.diagnostics : null;
  const exitDiagnostics = generateExitDiagnostics(diagnostics);
  const detail = {
    jobStatus: {
      username: framework.metadata.labels
        ? framework.metadata.labels.userName
        : 'unknown',
      state: convertState(
        framework.status.state,
        completionStatus ? completionStatus.code : null,
        framework.status.retryPolicyStatus.retryDelaySec,
      ),
      originState: framework.status.state,
      retries: framework.status.retryPolicyStatus.totalRetriedCount,
      retryIndex: framework.status.attemptStatus.id,
      jobStartedTime: new Date(framework.metadata.creationTimestamp).getTime(),
      retryStartedTime: new Date(
        framework.metadata.creationTimestamp,
      ).getTime(),
      retryCompletedTime: new Date(framework.status.completionTime).getTime(),
      appId: framework.status.attemptStatus.instanceUID,
      appProgress: completionStatus ? 1 : 0,
      appTrackingUrl: '',
      appLaunchedTime: new Date(framework.metadata.creationTimestamp).getTime(),
      appCompletedTime: new Date(framework.status.completionTime).getTime(),
      appExitCode: completionStatus ? completionStatus.code : null,
      appExitDiagnostics: exitDiagnostics
        ? exitDiagnostics.diagnosticsSummary
        : null,
      appExitMessages: exitDiagnostics
        ? {
            container: null,
            runtime: exitDiagnostics.runtime,
            launcher: exitDiagnostics.launcher,
          }
        : null,
      appExitTriggerMessage:
        completionStatus && completionStatus.trigger
          ? completionStatus.trigger.message
          : null,
      appExitTriggerTaskRoleName:
        completionStatus && completionStatus.trigger
          ? completionStatus.trigger.taskRoleName
          : null,
      appExitTriggerTaskIndex:
        completionStatus && completionStatus.trigger
          ? completionStatus.trigger.taskIndex
          : null,
      appExitType: completionStatus ? completionStatus.type.name : null,
    },
    taskRoles: {},
  };
  const ports = {};
  for (let taskRoleSpec of framework.spec.taskRoles) {
    ports[taskRoleSpec.name] =
      taskRoleSpec.task.pod.metadata.annotations[
        'rest-server/port-scheduling-spec'
      ];
  }

  const userName = framework.metadata.labels
    ? framework.metadata.labels.userName
    : 'unknown';
  const jobName = decodeName(
    framework.metadata.name,
    framework.metadata.labels,
  );

  for (let taskRoleStatus of framework.status.attemptStatus.taskRoleStatuses) {
    detail.taskRoles[taskRoleStatus.name] = {
      taskRoleStatus: {
        name: taskRoleStatus.name,
      },
      taskStatuses: await Promise.all(
        taskRoleStatus.taskStatuses.map(
          async (status) =>
            await convertTaskDetail(
              status,
              ports[taskRoleStatus.name],
              userName,
              jobName,
              taskRoleStatus.name,
            ),
        ),
      ),
    };
  }
  return detail;
};

const convertTaskDetail = async (
  taskStatus,
  ports,
  userName,
  jobName,
  taskRoleName,
) => {
  // get container gpus
  let containerGpus = null;
  try {
    const pod = (await axios({
      method: 'get',
      url: launcherConfig.podPath(taskStatus.attemptStatus.podName),
      headers: launcherConfig.requestHeaders,
      httpsAgent: apiserver.ca && new Agent({ca: apiserver.ca}),
    })).data;
    if (launcherConfig.enabledHived) {
      const isolation =
        pod.metadata.annotations[
          'hivedscheduler.microsoft.com/pod-gpu-isolation'
        ];
      containerGpus = isolation
        .split(',')
        .reduce((attr, id) => attr + Math.pow(2, id), 0);
    } else {
      const gpuNumber = k8s.atoi(
        pod.spec.containers[0].resources.limits['nvidia.com/gpu'],
      );
      // mock GPU ids from 0 to (gpuNumber - 1)
      containerGpus = Math.pow(2, gpuNumber) - 1;
    }
  } catch (err) {
    containerGpus = null;
  }
  const completionStatus = taskStatus.attemptStatus.completionStatus;
  return {
    taskIndex: taskStatus.index,
    taskState: convertState(
      taskStatus.state,
      completionStatus ? completionStatus.code : null,
      taskStatus.retryPolicyStatus.retryDelaySec,
    ),
    containerId: taskStatus.attemptStatus.podUID,
    containerIp: taskStatus.attemptStatus.podHostIP,
    containerGpus,
    containerLog: `http://${taskStatus.attemptStatus.podHostIP}:${process.env.LOG_MANAGER_PORT}/log-manager/tail/${userName}/${jobName}/${taskRoleName}/${taskStatus.attemptStatus.podUID}/`,
    containerExitCode: completionStatus ? completionStatus.code : null,
  };
};

const generateExitDiagnostics = (diag) => {
  if (_.isEmpty(diag)) {
    return null;
  }

  const exitDiagnostics = {
    diagnosticsSummary: diag,
    runtime: null,
    launcher: diag,
  };
  const regex = /matched: (.*)/;
  const matches = diag.match(regex);

  // No container info here
  if (matches === null || matches.length < 2) {
    return exitDiagnostics;
  }

  let podCompletionStatus = null;
  try {
    podCompletionStatus = JSON.parse(matches[1]);
  } catch (error) {
    logger.warn('Get diagnostics info failed', error);
    return exitDiagnostics;
  }

  const summmaryInfo = diag.substring(0, matches.index + 'matched:'.length);
  exitDiagnostics.diagnosticsSummary =
    summmaryInfo + '\n' + yaml.safeDump(podCompletionStatus);
  exitDiagnostics.launcher = exitDiagnostics.diagnosticsSummary;

  // Get runtime output, set launcher output to null. Otherwise, treat all message as launcher output
  exitDiagnostics.runtime = extractRuntimeOutput(podCompletionStatus);
  if (exitDiagnostics.runtime !== null) {
    exitDiagnostics.launcher = null;
    return exitDiagnostics;
  }

  return exitDiagnostics;
};

const extractRuntimeOutput = (podCompletionStatus) => {
  if (_.isEmpty(podCompletionStatus)) {
    return null;
  }

  let res = null;
  for (const container of podCompletionStatus.containers) {
    if (container.code <= 0) {
      continue;
    }
    const message = container.message;
    if (message == null) {
      continue;
    }
    const anchor1 = /\[PAI_RUNTIME_ERROR_START\]/;
    const anchor2 = /\[PAI_RUNTIME_ERROR_END\]/;
    const match1 = message.match(anchor1);
    const match2 = message.match(anchor2);
    if (match1 !== null && match2 !== null) {
      const start = match1.index + match1[0].length;
      const end = match2.index;
      const output = message.substring(start, end).trim();
      try {
        res = {
          ...yaml.safeLoad(output),
          name: container.name,
        };
      } catch (error) {
        logger.warn('failed to format runtime output:', output, error);
      }
      break;
    }
  }
  return res;
};

// module exports
module.exports = {
  convertToJobAttempt,
  convertToJobAttemptDetail,
};