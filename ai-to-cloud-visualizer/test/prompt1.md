Act as an expert Cloud Architect. You have direct access to the AWS CLI via your connected AWS MCP. I need you to actively execute a sequence of AWS commands to deploy a simple load-balanced architecture. The exact execution traces and JSON outputs you generate are being captured by my local D2 state reconciliation visualizer, so you must run them sequentially and successfully.

Please execute the following steps directly using your AWS MCP tools:
1. Create a dummy VPC and two public Subnets.
2. Create an internet-facing Application Load Balancer (ALB) in those subnets.
3. Provision 3 separate EC2 instances using `run-instances`.
4. Create a Target Group, a Listener for the ALB, and register the 3 EC2 instances to the Target Group.
5. Configure a High CPU Utilization CloudWatch metric alarm for each of the 3 instances using `put-metric-alarm`.

Strict Instructions:
- Do not just write a bash script or CloudFormation template for me to run.
- You MUST execute these commands directly in our session using your MCP tool.
- Execute them sequentially: wait for the JSON output of one command (e.g., extracting the VPC ID) to feed into the next one.
- Keep the resources minimal (e.g., t2.micro, dummy AMI) just to trigger the successful creation traces.