import { adrMessage, fenced, text } from "./context.js";
import { SHORT_ARG_MAX, type PromptDefinition } from "./types.js";

export const wallAudit: PromptDefinition = {
  name: "wall-audit",
  title: "Audit a file or PR for Wall leakage",
  description:
    "Pre-loads ADR-006 and scans a file or pull request for Spring, Netty and servlet types that cross the kernel boundary. The target is named by the user; the bridge never reads it.",
  arguments: [
    {
      name: "target",
      description: "Optional file path or pull request to audit, as text. The bridge does not read it; the agent does.",
      required: false,
      maxLength: SHORT_ARG_MAX,
    },
  ],
  render(ctx, args) {
    const target = args.target?.trim();
    const subject =
      target !== undefined && target.length > 0
        ? "The audit target, as text supplied by the user (read it yourself with your own tools):\n\n" + fenced(target, "text")
        : "No target was named. Ask which file, module or pull request to audit.";
    return {
      description: wallAudit.description,
      messages: [
        text(
          "Audit a target for leakage across the Wall. The context is ADR-006, Spring-Free Kernel Boundary: `exeris-kernel-spi` and `exeris-kernel-core` are Spring-free, and `exeris-kernel-enterprise` depends only on SPI and Core.\n\n" +
            subject,
        ),
        adrMessage(ctx, 6),
        text(
          [
            "Scan the target, in the kernel SPI, Core and enterprise modules and in anything a capability pulls in, for:",
            "",
            "- Spring: any `org.springframework.*` import, a Spring annotation (`@Component`, `@Autowired`, `@Configuration`, `@Bean`, `@Value`), a Spring Boot starter or BOM on a kernel module, an `ApplicationContext` or `BeanFactory`.",
            "- Netty: any `io.netty.*` import or a Netty dependency, unless ADR-006 above permits it in that module.",
            "- Servlet and web-container types: `jakarta.servlet.*`, `javax.servlet.*`, `HttpServletRequest`, filters, `@RestController` or other web-MVC types on a kernel or capability path.",
            "- Dependency-injection containers or decorators-as-DI introduced as a kernel dependency.",
            "- The same boundary one tier up: a capability reaching into Spring internals, a sibling capability's private classes, or kernel private packages.",
            "",
            "Check build files as well as source: a leaked dependency in a POM is a leak without an import. Report each finding with file, line and the ADR-006 rule it breaks, and state what you scanned and found clean, so that an empty result is distinguishable from an unfinished scan.",
          ].join("\n"),
        ),
      ],
    };
  },
};
