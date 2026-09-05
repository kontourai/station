import type { CloudMoveTarget } from '@kontourai/station-contracts/cloud-move';

/** Render-only preparation. CloudFormation success is not Station readiness. */
export function awsEc2EnvironmentTemplate(input: {
  target: CloudMoveTarget;
  image: string;
}): Record<string, unknown> {
  if (!/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(input.image))
    throw new Error(
      'Use a digest-pinned, publicly readable Linux/x86 Station image',
    );
  const ref = (name: string) => ({ Ref: name });
  const sub = (value: string) => ({ 'Fn::Sub': value });
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description:
      'Station private development environment. No source setup, credentials, or execution authority are transferred.',
    Parameters: {
      VpcId: {
        Type: 'AWS::EC2::VPC::Id',
        Description: 'Existing VPC for the selected public subnet.',
      },
      SubnetId: {
        Type: 'AWS::EC2::Subnet::Id',
        Description:
          'Existing subnet with Internet routing for SSM and public image/package downloads.',
      },
      AmiId: {
        Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
        Default:
          '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
      },
      RootVolumeGiB: {
        Type: 'Number',
        Default: 30,
        MinValue: 30,
        MaxValue: 200,
        Description:
          'Encrypted gp3 root/data volume, retained after termination; retained storage continues billing.',
      },
    },
    Resources: {
      SecurityGroup: {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupDescription:
            'No inbound rules; access through authenticated SSM port forwarding.',
          VpcId: ref('VpcId'),
          SecurityGroupIngress: [],
          SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '0.0.0.0/0' }],
        },
      },
      InstanceRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { Service: ['ec2.amazonaws.com'] },
                Action: ['sts:AssumeRole'],
              },
            ],
          },
          ManagedPolicyArns: [
            sub(
              // biome-ignore lint/suspicious/noTemplateCurlyInString: CloudFormation substitution, not JavaScript.
              'arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore',
            ),
          ],
        },
      },
      InstanceProfile: {
        Type: 'AWS::IAM::InstanceProfile',
        Properties: { Roles: [ref('InstanceRole')] },
      },
      Station: {
        Type: 'AWS::EC2::Instance',
        Properties: {
          ImageId: ref('AmiId'),
          InstanceType: input.target.instanceType,
          IamInstanceProfile: ref('InstanceProfile'),
          MetadataOptions: {
            HttpTokens: 'required',
            HttpPutResponseHopLimit: 1,
          },
          CreditSpecification: { CPUCredits: 'standard' },
          NetworkInterfaces: [
            {
              DeviceIndex: '0',
              AssociatePublicIpAddress: true,
              SubnetId: ref('SubnetId'),
              GroupSet: [ref('SecurityGroup')],
            },
          ],
          BlockDeviceMappings: [
            {
              DeviceName: '/dev/xvda',
              Ebs: {
                VolumeType: 'gp3',
                VolumeSize: ref('RootVolumeGiB'),
                Encrypted: true,
                DeleteOnTermination: false,
              },
            },
          ],
          // biome-ignore lint/suspicious/noTemplateCurlyInString: CloudFormation substitution, not JavaScript.
          Tags: [{ Key: 'Name', Value: sub('${AWS::StackName}-station') }],
          UserData: {
            'Fn::Base64': [
              '#!/bin/bash',
              'set -euo pipefail',
              'dnf install -y docker',
              'systemctl enable --now docker',
              'install -d -m 0700 -o 1000 -g 1000 /var/lib/station/home /var/lib/station/workspace',
              `docker pull '${input.image}'`,
              `docker run -d --name station --restart unless-stopped --security-opt no-new-privileges:true --stop-timeout 30 --log-driver local --log-opt max-size=10m --log-opt max-file=3 -p 127.0.0.1:3000:3000 --mount type=bind,src=/var/lib/station/home,dst=/data/station --mount type=bind,src=/var/lib/station/workspace,dst=/workspace '${input.image}'`,
            ].join('\n'),
          },
        },
      },
    },
    Outputs: {
      InstanceId: { Value: ref('Station') },
      Region: { Value: ref('AWS::Region') },
      Access: {
        Value:
          'Use AWS Systems Manager port forwarding to remote port 3000; local port is operator-selected. Station authentication is still required.',
      },
      Persistence: {
        Value:
          'Root EBS volume survives stop/start and is retained on instance termination. A replacement instance does not automatically adopt it. Verify ownership and restore explicitly.',
      },
      Readiness: {
        Value:
          'Resource creation alone does not establish application readiness, transfer completion, or resumed execution. Inspect bootstrap logs and verify Station before enrollment.',
      },
    },
  };
}
