import {
  Allure,
  AllureGroup,
  AllureRuntime,
  AllureStep,
  AllureTest,
  Attachment,
  Category,
  ContentType,
  ExecutableItemWrapper,
  IAllureConfig,
  isPromise,
  LabelName,
  LinkType,
  Stage,
  Status,
  StepInterface,
  Severity,
} from 'allure-js-commons';
import stripAnsi from 'strip-ansi';
import { relative } from 'path';

enum SpecStatus {
  PASSED = 'passed',
  FAILED = 'failed',
  BROKEN = 'broken',
  PENDING = 'pending',
  DISABLED = 'disabled',
  EXCLUDED = 'excluded',
  TODO = 'todo',
}
export const dateStr = () => {
  const date = new Date(Date.now());
  return (
    date.getFullYear() +
    '-' +
    (date.getMonth() + 1) +
    '-' +
    date.getDate() +
    ' ' +
    date.getUTCHours() +
    ':' +
    date.getMinutes() +
    ':' +
    date.getSeconds() +
    '.' +
    date.getMilliseconds()
  );
};
export class AllureReporter extends Allure {
  private runningTest: AllureTest | null = null;
  private runningGroup: AllureGroup | null = null;
  private runningExecutable: ExecutableItemWrapper | null = null;
  private groupStack: AllureGroup[] = [];
  private groupNameStack: string[] = [];
  private stepStack: AllureStep[] = [];
  private stepNameStack: string[] = [];
  private environmentInfo: Record<string, string> = {};

  constructor(config?: IAllureConfig) {
    super(new AllureRuntime(config ?? { resultsDir: 'allure-results' }));
  }

  get currentGroup(): AllureGroup {
    if (this.runningGroup === null) {
      throw new Error('No active group');
    }

    return this.runningGroup;
  }

  get currentTest(): AllureTest {
    if (this.runningTest === null) {
      throw new Error('No active test');
    }

    return this.runningTest;
  }

  protected get currentExecutable(): ExecutableItemWrapper {
    return this.currentStep ?? this.currentTest;
  }

  startGroup(name: string) {
    // todo check currentgroup.startgroup
    // todo check empty name
    this.runningGroup = this.runtime.startGroup(name);
    let nameGr = name;

    for (let i = 0; i < this.groupStack.length + 1; i++) {
      if (this.groupStack.length > i) {
        for (let j = 0; j <= i; j++) {
          nameGr = name.replace(this.groupStack[j].name, '');
        }
      }
    }

    this.groupNameStack.push(nameGr);
    this.groupStack.push(this.currentGroup);
  }

  // todo remove - change name someway
  // todo decorators
  startTest(spec: any) {
    this.runningTest = this.currentGroup.startTest(spec.description);
    this.runningTest.fullName = spec.fullName;

    // Capture Jest worker thread for timeline report
    if (process.env.JEST_WORKER_ID) {
      this.currentTest.addLabel(
        LabelName.THREAD,
        `${process.env.JEST_WORKER_ID}`,
      );
    }

    this.applyGroupping(spec);
  }

  startStep(name: string, start?: number): AllureStep {
    const allureStep = this.currentExecutable.startStep(
      dateStr() + ' | ' + name,
      start,
    );
    this.stepStack.push(allureStep);
    this.stepNameStack.push(name);
    return allureStep;
  }

  endStep(status?: Status, stage?: Stage, end?: number) {
    // console.log('END:' + JSON.stringify(this.stepNameStack));
    const step = this.stepStack.pop();
    this.stepNameStack.pop();

    if (!step) {
      console.log('No step started');
      // throw new Error('No step started');
      return;
    }
    step.stage = stage ?? Stage.FINISHED;
    if (status) {
      step.status = status;
    }
    step.endStep(end);
  }

  private endSteps() {
    while (this.currentStep !== null) {
      this.endStep(Status.FAILED);
    }
  }

  private applyGroupping(spec: any): void {
    const replaceDot = (name: string): string => {
      // todo regexp with \s
      if (name.substr(0, 1) === '.') {
        return name.substr(1, name.length - 1);
      }
      if (name.substr(name.length - 1) === '.') {
        return name.substr(0, name.length - 1);
      }
      return name;
    };
    const groups = this.groupNameStack.map((p) => replaceDot(p));
    this.addPackage(groups.join('.'));

    if (groups.length > 0) {
      this.parentSuite(groups[0]);
    }

    if (groups.length > 1) {
      this.suite(groups[1]);
    }

    if (groups.length > 2) {
      this.subSuite(groups[2]);
    }
    if (groups.length > 3) {
      this.currentTest.name =
        groups.slice(3).join(' > ') + ' \n >> ' + spec.description;
    }
  }

  // todo type
  endTest(spec: any) {
    this.endSteps();

    if (spec.status === SpecStatus.PASSED) {
      this.currentTest.status = Status.PASSED;
      this.currentTest.stage = Stage.FINISHED;
    }

    if (spec.status === SpecStatus.BROKEN) {
      this.currentTest.status = Status.BROKEN;
      this.currentTest.stage = Stage.FINISHED;
    }

    if (spec.status === SpecStatus.FAILED) {
      this.currentTest.status = Status.FAILED;
      this.currentTest.stage = Stage.FINISHED;
    }

    if (
      spec.status === SpecStatus.PENDING ||
      spec.status === SpecStatus.DISABLED ||
      spec.status === SpecStatus.EXCLUDED ||
      spec.status === SpecStatus.TODO
    ) {
      this.currentTest.status = Status.SKIPPED;
      this.currentTest.stage = Stage.PENDING;
      this.currentTest.detailsMessage = spec.pendingReason || 'Suite disabled';
    }

    // Capture exceptions
    const exceptionInfo =
      this.findMessageAboutThrow(spec.failedExpectations) ||
      this.findAnyError(spec.failedExpectations);

    if (exceptionInfo !== null && typeof exceptionInfo.message === 'string') {
      let { message } = exceptionInfo;

      message = stripAnsi(message);

      this.currentTest.detailsMessage = message;

      if (exceptionInfo.stack && typeof exceptionInfo.stack === 'string') {
        let { stack } = exceptionInfo;

        stack = stripAnsi(stack);
        stack = stack.replace(message, '');

        this.currentTest.detailsTrace = stack;
      }
    }

    this.currentTest.endTest();
  }

  get currentStep(): AllureStep | null {
    if (this.stepStack.length > 0) {
      return this.stepStack[this.stepStack.length - 1];
    }

    return null;
  }

  writeCategories(categories: Category[]) {
    super.writeCategoriesDefinitions(categories);
  }

  endGroup() {
    if (!this.currentGroup) {
      throw new Error('No runningGroup');
    }

    this.runtime.writeGroup({
      name: this.currentGroup.name,
      uuid: this.currentGroup.uuid,
      befores: [],
      afters: [],
      children: [],
    });
    this.groupStack.pop();
    this.groupNameStack.pop();
    this.currentGroup.endGroup();
  }

  private findMessageAboutThrow(expectations?: any[]): any | null {
    for (const expectation of expectations || []) {
      if (expectation.matcherName === '') {
        return expectation;
      }
    }

    return null;
  }

  private findAnyError(expectations?: any[]): any | null {
    expectations = expectations || [];
    if (expectations.length > 0) {
      return expectations[0];
    }

    return null;
  }

  public step<T>(
    name: string,
    body?: (step: StepInterface) => T,
    start?: number,
    ...args: any[]
  ): any {
    const allureStep = this.startStep(name, start);
    let result;

    if (!body) {
      this.endStep(Status.PASSED);
      return;
    }

    try {
      result = allureStep.wrap(body)(args);
    } catch (error) {
      this.endStep(Status.FAILED);
      throw error;
    }

    if (isPromise(result)) {
      const promise = result as Promise<any>;
      return promise
        .then((a) => {
          this.endStep(Status.PASSED);
          return a;
        })
        .catch((error) => {
          console.log('Result fail: isPromise');
          this.endStep(Status.FAILED);
          throw error;
        });
    } else {
      this.endStep(Status.PASSED);
      return result;
    }
  }

  addEnvironment(name: string, value: string) {
    this.environmentInfo[name] = value;
    super.writeEnvironmentInfo(this.environmentInfo);
    return this;
  }

  writeAttachment(content: Buffer | string, type: ContentType): string {
    return this.runtime.writeAttachment(content, type);
  }

  public logStep(
    name: string,
    status: Status,
    attachments?: [Attachment],
  ): void {
    // console.log('AllureImpl status:', status);
    /*const wrappedStep = this.startStep(name);

                if (attachments) {
                    for (const {name, content, type} of attachments) {
                        this.attachment(name, content, type);
                    }
                }

                wrappedStep.logStep(status);
                wrappedStep.endStep();*/
  }

  public attachment(name: string, content: Buffer | string, type: ContentType) {
    const file = this.runtime.writeAttachment(content, type);

    this.currentTest.addAttachment(name, type, file);
  }

  public stepAttachement(
    name: string,
    content: Buffer | string,
    type: ContentType,
  ) {
    const file = this.runtime.writeAttachment(content, type);

    this.currentExecutable.addAttachment(name, type, file);
  }

  addPackage(value: string) {
    this.currentTest.addLabel(LabelName.PACKAGE, value);
    return this;
  }

  addParameter(name: string, value: string) {
    this.currentExecutable.addParameter(name, value);
    return this;
  }

  addParameters(...params: [string, any][]) {
    params.forEach((p) => {
      const value = typeof p[1] !== 'string' ? JSON.stringify(p[1]) : p[1];
      this.currentExecutable.addParameter(p[0], value);
    });
    return this;
  }

  addTestPathParameter(relativeFrom: string, spec: any) {
    const relativePath = relative(relativeFrom, spec.testPath);
    this.addParameter('Test Path', relativePath);
    return this;
  }

  addLink(options: { name?: string; url: string; type?: LinkType }) {
    this.currentTest.addLink(
      options.url,
      options.name ?? options.url,
      options.type,
    );
    return this;
  }

  addIssue(options: { id: string; name?: string; url?: string }) {
    // todo config
    /* options.url ??
        (this.config?.issueUri ? this.config.issueUri(options.id) : undefined);*/
    /*if (!url) {
      throw new Error('Specify url or issueUri in config');
    }*/
    const link = `${options.url}${options.id}`;
    this.issue(options.name ?? options.id, link);
    return this;
  }

  addTms(options: { id: string; name?: string; url?: string }) {
    // todo config
    // const uri = 'some';
    /* options.url ??
        (this.config?.tmsUri ? this.config.tmsUri(options.id) : undefined);*/
    /*if (!uri) {
      throw new Error('Specify url or tmsUri in config');
    }*/
    const link = `${options.url}${options.id}`;
    this.tms(options.name ?? options.id, link);

    return this;
  }

  addAttachment(name: string, buffer: any, type: ContentType) {
    this.stepAttachement(name, buffer, type);
    return this;
  }

  addTestAttachment(name: string, buffer: any, type: ContentType) {
    this.attachment(name, buffer, type);
    return this;
  }

  addLabel(name: string, value: string) {
    this.currentTest.addLabel(name, value);
    return this;
  }

  description(description: string) {
    this.currentTest.description = description;
    return this;
  }

  descriptionHtml(description: string) {
    this.currentTest.descriptionHtml = description;
    return this;
  }

  feature(feature: string) {
    super.feature(feature);
  }

  story(story: string) {
    super.story(story);
  }

  tag(tag: string) {
    super.tag(tag);
  }

  owner(owner: string) {
    super.owner(owner);
  }

  lead(lead: string) {
    super.label(LabelName.LEAD, lead);
  }

  framework(framework: string) {
    super.label(LabelName.FRAMEWORK, framework);
  }

  language(language: string) {
    super.label(LabelName.LANGUAGE, language);
  }

  as_id(id: string) {
    super.label(LabelName.AS_ID, id);
  }

  host(host: string) {
    super.label(LabelName.HOST, host);
  }

  testClass(testClass: string) {
    super.label(LabelName.TEST_CLASS, testClass);
  }

  testMethod(testMethod: string) {
    super.label(LabelName.TEST_METHOD, testMethod);
  }

  severity(severity: Severity) {
    super.severity(severity);
  }
}
